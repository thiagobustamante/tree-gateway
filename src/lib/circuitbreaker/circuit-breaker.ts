"use strict";

import {CircuitBreakerConfig} from "../config/circuit-breaker";
import {ApiConfig} from "../config/api";
import {Stats} from "../stats/stats";
import * as express from "express";
import * as _ from "lodash";
import {CircuitBreaker} from "./express-circuit-breaker"
import {Gateway} from "../gateway"
import * as Groups from "../group";
import * as pathUtil from "path";
import {RedisStateHandler} from "./redis-state-handler";

class StatsController {
    open: Stats;
    halfOpen: Stats;
    close: Stats;
    rejected: Stats;
    success: Stats;
    failure: Stats;
    timeout: Stats;
}

interface BreakerInfo{
    circuitBreaker?: CircuitBreaker;
    groupValidator?: (req:express.Request, res:express.Response)=>boolean;
}

export class ApiCircuitBreaker {
    private gateway: Gateway;

    constructor(gateway: Gateway) {
        this.gateway = gateway;
    }

    circuitBreaker(apiRouter: express.Router, api: ApiConfig) {
        let path: string = api.proxy.path;
        let breakerInfos: Array<BreakerInfo> = new Array<BreakerInfo>();
        let sortedBreakers = this.sortBreakers(api.circuitBreaker, api.proxy.path);

        sortedBreakers.forEach((cbConfig: CircuitBreakerConfig) => {
            let breakerInfo: BreakerInfo = {}; 
            let cbOptions: any = {
                timeout: cbConfig.timeout || 30000,
                resetTimeout: cbConfig.resetTimeout || 120000,
                maxFailures: (cbConfig.maxFailures || 10),
                stateHandler: new RedisStateHandler(api.proxy.path, this.gateway)
            };
            if (this.gateway.logger.isDebugEnabled()) {
                this.gateway.logger.debug(`Configuring Circuit Breaker for path [${api.proxy.path}].`);
            }
            breakerInfo.circuitBreaker = new CircuitBreaker(cbOptions);
            this.configureCircuitBreakerEventListeners(breakerInfo, api.proxy.path, cbConfig);
            if (cbConfig.group){
                if (this.gateway.logger.isDebugEnabled()) {
                    let groups = Groups.filter(api.group, cbConfig.group);
                    this.gateway.logger.debug(`Configuring Group filters for Circuit Breaker on path [${api.proxy.path}]. Groups [${JSON.stringify(groups)}]`);
                }
                breakerInfo.groupValidator = Groups.buildGroupAllowFilter(api.group, cbConfig.group);
            }
            breakerInfos.push(breakerInfo);        
        });

        this.setupMiddlewares(apiRouter, breakerInfos);
    }
    
    private configureCircuitBreakerEventListeners(breakerInfo: BreakerInfo, path: string, config: CircuitBreakerConfig) {
        let stats  = this.createCircuitBreakerStats(path, config);
        if (stats) {
            breakerInfo.circuitBreaker.on('open', ()=>{
                stats.open.registerOccurrence('total', 1);
            });
            breakerInfo.circuitBreaker.on('close', ()=>{
                stats.close.registerOccurrence('total', 1);
            });
            breakerInfo.circuitBreaker.on('rejected', ()=>{
                stats.rejected.registerOccurrence('total', 1);
            });
        }
        if (config.onOpen) {
            let p = pathUtil.join(this.gateway.middlewarePath, 'circuitbreaker', 'handler' , config.onOpen);                
            let openHandler = require(p);
            breakerInfo.circuitBreaker.on('open', ()=>{
                openHandler(path);
            });
        }
        if (config.onClose) {
            let p = pathUtil.join(this.gateway.middlewarePath, 'circuitbreaker', 'handler' , config.onClose);                
            let closeHandler = require(p);
            breakerInfo.circuitBreaker.on('close', ()=>{
                closeHandler(path);
            });
        }
        if (config.onRejected) {
            let p = pathUtil.join(this.gateway.middlewarePath, 'circuitbreaker', 'handler' , config.onRejected);                
            let rejectedHandler = require(p);
            breakerInfo.circuitBreaker.on('rejected', ()=>{
                rejectedHandler(path);
            });
        }        
    }

    private setupMiddlewares(apiRouter: express.Router, throttlingInfos: Array<BreakerInfo>) {
        throttlingInfos.forEach((breakerInfo: BreakerInfo) =>{
            apiRouter.use(this.buildMiddleware(breakerInfo));
        });
    }
    
    private buildMiddleware(breakerInfo: BreakerInfo) {
        let circuitBreakerMiddleware = breakerInfo.circuitBreaker.middleware();
        
        return (req: express.Request, res: express.Response, next: express.NextFunction)=>{
            if (breakerInfo.groupValidator) {
                if (breakerInfo.groupValidator(req, res)) {
                    circuitBreakerMiddleware(req, res, next);
                }
                else {
                    next();
                }
            }
            else {
                circuitBreakerMiddleware(req, res, next);
            }
        };
    }    

    private sortBreakers(breakers: Array<CircuitBreakerConfig>, path: string): Array<CircuitBreakerConfig> {
        let generalBreakers = _.filter(breakers, (value)=>{
            if (value.group) {
                return true;
            }
            return false;
        });
        
        if (generalBreakers.length > 1) {
            this.gateway.logger.error(`Invalid circuit breaker configuration for api [${path}]. Conflicting configurations for default group`);
                return [];
        }

        if (generalBreakers.length > 0) {
            let index = breakers.indexOf(generalBreakers[0]);
            if (index < breakers.length -1) {
                let gen = breakers.splice(index, 1);
                breakers.push(gen)   
            }
        }
        return breakers;
    }

    private createCircuitBreakerStats(path: string, config: CircuitBreakerConfig) : StatsController {
        if ((!config.disableStats) && (this.gateway.statsConfig)) {
            let stats: StatsController = new StatsController();
            stats.close = this.gateway.createStats(Stats.getStatsKey('circuitbreaker', path, 'close'));
            stats.open = this.gateway.createStats(Stats.getStatsKey('circuitbreaker', path, 'open'));
            stats.rejected = this.gateway.createStats(Stats.getStatsKey('circuitbreaker', path, 'rejected'));
            // stats.failure = this.gateway.createStats(Stats.getStatsKey('circuitbreaker', path, 'failure'));
            // stats.halfOpen = this.gateway.createStats(Stats.getStatsKey('circuitbreaker', path, 'halfOpen'));
            // stats.timeout = this.gateway.createStats(Stats.getStatsKey('circuitbreaker', path, 'timeout'));
            // stats.success = this.gateway.createStats(Stats.getStatsKey('circuitbreaker', path, 'success'));
            
            return stats;
        }

        return null;
    }
}

