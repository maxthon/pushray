import fastifyModule from 'fastify';
import cors from '@fastify/cors'
import dotenv from "dotenv";

import { Logger } from './logger.js';
import { Config } from './config.js';
import { Util } from './common/util.js';

dotenv.config({ path: "env" })
const app = fastifyModule({ logger: false });
const gl = {}
// 创建默认logger实例
const logger = new Logger({
    serviceName: process.env.APP_NAME || 'rest-template',
    logDir: process.env.LOG_DIR || './logs'
});
gl.logger = logger
gl.app = app
gl.config = Config
async function onExit() {
    console.log("exiting...")
    process.exit(0);
}
async function startServer() {
    const port = process.env.port || 8080
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Starting ${process.env.APP_NAME} service on:`, port)
}

async function main() {
    await regEndpoints()
    //create more classes here
    await Util.create(gl)
    if (process.env.Modules.indexOf("redis") != -1) {
        const { Redis } = await import('./redis.js')
        await Redis.create(gl)
    }
    if (process.env.Modules.indexOf("user") != -1) {
        const { DB } = await import('./db.js')
        await DB.create(gl)
        const { User } = await import('./user.js')
        await User.create(gl)
    }

    await startServer()
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);
}
async function regEndpoints() {
    await app.register(cors, { origin: true, credentials: true, allowedHeaders: ['content-type'] });
    app.addHook("preHandler", async (req, res) => {
        console.log(req.url)
    })
    app.get('/', (req, res) => {
        console.log(req.url)
        return Config.project.name
    })
    app.get('/test', async (req, res) => {

        return "ok"
    })
    app.post('/logSearch', async (req, res) => {
        const body = req.body
        console.log(body)
        return "ok"
    })
    app.post('/notify/_commonapi', async (req, res) => {
        const body = req.body
        console.log(body)
        const { cmd, result } = body
        if (cmd === 'login_successful') {

        }
        return "ok"
    })
}
main()
