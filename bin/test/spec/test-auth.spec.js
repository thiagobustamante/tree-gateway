"use strict";
var express = require("express");
var request = require("request");
require("jasmine");
var gateway_1 = require("../lib/gateway");
var settings_1 = require("../lib/settings");
var typescript_ioc_1 = require("typescript-ioc");
var provider = {
    get: function () {
        var settings = new settings_1.Settings();
        settings.app = express();
        return settings;
    }
};
typescript_ioc_1.Container.bind(settings_1.Settings).scope(typescript_ioc_1.Scope.Singleton).provider(provider);
var gateway = new gateway_1.Gateway();
var app = gateway.server;
var port = 4567;
var gatewayAddress = "http://localhost:" + port;
var server;
app.set('env', 'test');
describe("Gateway Tests", function () {
    beforeAll(function (done) {
        console.log('\nInitializing gateway...');
        gateway.configure(__dirname + '/apis', function () {
            console.log('Gateway configured');
            server = app.listen(port, function () {
                console.log('Gateway started');
                done();
            });
        });
    });
    afterAll(function () {
        server.close();
    });
    describe("The Gateway Proxy", function () {
        it("should be able to proxy an API", function (done) {
            request(gatewayAddress + "/test/get?arg=1", function (error, response, body) {
                var result = JSON.parse(body);
                expect(result.args.arg).toEqual("1");
                done();
            });
        });
        it("should be able to filter requests by method", function (done) {
            request(gatewayAddress + "/test/post", function (error, response, body) {
                expect(response.statusCode).toEqual(405);
                done();
            });
        });
    });
    describe("The Gateway Limit Controller", function () {
        it("should be able to limit the requests to API", function (done) {
            request(gatewayAddress + "/limited/get?arg=1", function (error, response, body) {
                var result = JSON.parse(body);
                expect(result.args.arg).toEqual("1");
                request(gatewayAddress + "/limited/get?arg=1", function (error, response, body) {
                    expect(response.statusCode).toEqual(429);
                    expect(body).toEqual("Too many requests, please try again later.");
                    done();
                });
            });
        });
    });
});

//# sourceMappingURL=test-auth.spec.js.map
