import { BaseService } from "./baseService.js";

export class Util extends BaseService {
    async init(gl) {

    }
    getClientIp(req) {
        let IP =
            //req.ip ||
            req.headers['cf-connecting-ip'] ||
            req.headers["x-forwarded-for"] ||
            req.socket.remoteAddress ||
            req.connection.remoteAddress ||
            req.connection.socket.remoteAddress;
        IP = IP.split(',')[0]
        //IP = IP.split(":").pop()
        return IP;
    }
}