"use strict";

import {EventEmitter} from "events";
import * as express from "express";

export enum State {OPEN, CLOSED, HALF_OPEN};

export interface Options {
    timeout: number;
    resetTimeout: number;
    maxFailures: number;
    stateHandler: StateHandler;    
}

export interface StateHandler {
    halfOpenCallPending: boolean;
    isOpen(): boolean;
    isHalfOpen(): boolean;
    isClosed(): boolean;
    forceOpen(): boolean;
    forceHalfOpen(): boolean;
    forceClose(): boolean;
    incrementFailures(): Promise<number>;
}

export class CircuitBreaker extends EventEmitter {
    private options: Options;

    constructor(options: Options) {
        super();
        this.options = options;
        this.forceClosed();
    }
    
    isOpen() {
        return this.options.stateHandler.isOpen();
    }

    isHalfOpen() {
        return this.options.stateHandler.isHalfOpen();
    }

    isClosed() {
        return this.options.stateHandler.isClosed();
    }

    forceOpen() {
        if(!this.options.stateHandler.forceOpen()) {
            return;
        }

        let self = this;
        // After reset timeout circuit should enter half open state
        setTimeout(function () {
            self.forceHalfOpen();
        }, self.options.resetTimeout);

        self.emit('open');
    }

    forceClosed() {
        if(!this.options.stateHandler.forceClose()) {
            return;
        }
        this.emit('close');
    }

    forceHalfOpen() {
        if(!this.options.stateHandler.forceHalfOpen()) {
            return;
        }
        this.emit('halfOpen');
    }

    middleware(): express.RequestHandler {
        let self = this;
        return (req, res, next) => {
            // self.emit('request');
            if(self.isOpen() || (self.isHalfOpen() && self.options.stateHandler.halfOpenCallPending)) {
                return self.fastFail(res);
            } 
            else if(self.isHalfOpen() && !self.options.stateHandler.halfOpenCallPending) {
                self.options.stateHandler.halfOpenCallPending = true;
                return self.invokeApi(req, res, next);                
            } 
            else {
                return self.invokeApi(req, res, next);                
            }
        };
    }

    private invokeApi(requ, res, next) {
        let self = this;
        let operationTimeout = false;
        let timeoutID = setTimeout(()=>{
            operationTimeout = true;
            self.handleTimeout(res);
        }, self.options.timeout);
        let end = res.end;
        res.end = function(...args) {
            if (!operationTimeout) {
                clearTimeout(timeoutID);
                if (res.statusCode >= 500) {
                    self.options.stateHandler.halfOpenCallPending = false;
                    self.handleFailure(new Error("Circuit breaker API call failure"));//TODO pegar mensagem e status do response
                }
                else {
                    self.handleSuccess();
                }
            }
            res.end = end;
            res.end.apply(res, arguments);
        };
        
        return next();                
    }

    private fastFail(res: express.Response) {
        res.status(503);
        let err = new Error('CircuitBreaker open');
        res.end(err.message);
        this.emit('rejected', err);
    }

    private handleTimeout (res: express.Response) {
        let err = new Error('CircuitBreaker timeout');
        this.handleFailure(err);
        res.status(504);
        res.end(err.message);
        // this.emit('timeout', (Date.now() - startTime));
    }

    private handleSuccess() {
        this.forceClosed();

        // this.emit('success');
    }

    private handleFailure(err: Error) {
        this.options.stateHandler.incrementFailures()
        .then(numFailures => {
            if(this.isHalfOpen() || numFailures >= this.options.maxFailures) {
                this.forceOpen();
            }
        })

        // this.emit('failure', err);
    }
}   

