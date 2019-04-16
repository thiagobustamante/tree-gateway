'use strict';

import * as express from 'express';
import * as _ from 'lodash';
import * as auth from 'passport';
import { AutoWired, Inject } from 'typescript-ioc';
import { ApiConfig } from '../../config/api';
import { ApiAuthenticationConfig } from '../../config/authentication';
import { ApiPipelineConfig } from '../../config/gateway';
import { Logger } from '../../logger';
import { MiddlewareLoader } from '../../utils/middleware-loader';
import * as Groups from '../group';
import { RequestLog, RequestLogger } from '../stats/request';

@AutoWired
export class ApiAuth {
    @Inject private logger: Logger;
    @Inject private middlewareLoader: MiddlewareLoader;
    @Inject private requestLogger: RequestLogger;

    public authentication(apiRouter: express.Router, apiKey: string, api: ApiConfig, pipelineConfig: ApiPipelineConfig) {
        const path: string = api.path;
        const authentications: Array<ApiAuthenticationConfig> = this.sortMiddlewares(api.authentication, path);

        authentications.forEach((authentication: ApiAuthenticationConfig, index: number) => {
            try {
                authentication = this.resolveReferences(authentication, pipelineConfig);
                const authStrategy: auth.Strategy = this.middlewareLoader.loadMiddleware('authentication/strategy', authentication.strategy);
                if (!authStrategy) {
                    this.logger.error('Error configuring authenticator. Invalid Strategy');
                } else {
                    auth.use(`${apiKey}_${index}`, authStrategy);

                    const authenticator = auth.authenticate(`${apiKey}_${index}`, { session: false, failWithError: true });
                    if (authentication.group) {
                        this.createAuthenticatorForGroup(apiRouter, api, authentication, authenticator);
                    } else {
                        this.createAuthenticator(apiRouter, api, authentication, authenticator);
                    }

                    if (this.logger.isDebugEnabled) {
                        this.logger.debug(`Authentication Strategy [${this.middlewareLoader.getId(authentication.strategy)}] configured for path [${path}]`);
                    }
                }
            } catch (e) {
                this.logger.error(`Error configuring Authentication Strategy [${this.middlewareLoader.getId(authentication.strategy)}] for path [${path}]`, e);
            }
        });
    }

    private resolveReferences(authentication: ApiAuthenticationConfig, pipelineConfig: ApiPipelineConfig) {
        if (authentication.use && pipelineConfig.authentication) {
            if (pipelineConfig.authentication[authentication.use]) {
                authentication = _.defaults(authentication, pipelineConfig.authentication[authentication.use]);
            } else {
                throw new Error(`Invalid reference ${authentication.use}. There is no configuration for this id.`);
            }
        }
        return authentication;
    }

    private createAuthenticator(apiRouter: express.Router, api: ApiConfig, authentication: ApiAuthenticationConfig,
        authenticator: express.RequestHandler) {
        if (this.requestLogger.isRequestLogEnabled(api)) {
            apiRouter.use((req, res, next) => {
                authenticator(req, res, (err) => {
                    const requestLog: RequestLog = this.requestLogger.getRequestLog(req);
                    if (err) {
                        if (requestLog) {
                            requestLog.authentication = 'fail';
                        }
                        next(err);
                    } else {
                        if (requestLog) {
                            requestLog.authentication = 'success';
                        }
                        next();
                    }
                });
            });
        } else {
            apiRouter.use(authenticator);
        }
    }

    private createAuthenticatorForGroup(apiRouter: express.Router, api: ApiConfig, authentication: ApiAuthenticationConfig,
        authenticator: express.RequestHandler) {
        if (this.logger.isDebugEnabled()) {
            const groups = Groups.filter(api.group, authentication.group);
            this.logger.debug(`Configuring Group filters for Authentication on path [${api.path}]. Groups [${JSON.stringify(groups)}]`);
        }
        const f = Groups.buildGroupAllowFilter(api.group, authentication.group);
        if (this.requestLogger.isRequestLogEnabled(api)) {
            apiRouter.use((req, res, next) => {
                if (f(req, res)) {
                    authenticator(req, res, (err) => {
                        const requestLog: RequestLog = this.requestLogger.getRequestLog(req);
                        if (err) {
                            if (requestLog) {
                                requestLog.authentication = 'fail';
                            }
                            next(err);
                        } else {
                            if (requestLog) {
                                requestLog.authentication = 'success';
                            }
                            next();
                        }
                    });
                } else {
                    next();
                }
            });
        } else {
            apiRouter.use((req, res, next) => {
                if (f(req, res)) {
                    authenticator(req, res, next);
                } else {
                    next();
                }
            });
        }
    }

    private sortMiddlewares(middlewares: Array<ApiAuthenticationConfig>, path: string): Array<ApiAuthenticationConfig> {
        const generalMiddlewares = _.filter(middlewares, (value) => {
            if (value.group) {
                return false;
            }
            return true;
        });

        if (generalMiddlewares.length > 1) {
            this.logger.error(`Invalid authentication configuration for api [${path}]. Conflicting configurations for default group`);
            return [];
        }

        if (generalMiddlewares.length > 0) {
            const index = middlewares.indexOf(generalMiddlewares[0]);
            if (index < middlewares.length - 1) {
                const gen = middlewares.splice(index, 1);
                middlewares.push(gen[0]);
            }
        }
        return middlewares;
    }
}
