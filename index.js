import fastifyModule from 'fastify';
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fasticookie from '@fastify/cookie'
import dotenv from "dotenv";
import path from 'path';
import { fileURLToPath } from 'url';

import { Logger } from './logger.js';

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

async function onExit() {
    console.log("exiting...")
    process.exit(0);
}
async function startServer() {
    const port = process.env.PORT || 8080
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Starting ${process.env.APP_NAME} service on:`, port)
}
async function main() {
    await regEndpoints()
    //create more classes here
    const { Config } = await import('./config.js');
    gl.config = Config
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
    // 注册静态文件服务
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    await app.register(fastifyStatic, {
        root: path.join(__dirname, 'static'),
        prefix: '/static/'
    });

    await app.register(cors, { origin: true, credentials: true, allowedHeaders: ['content-type'] });
    app.addHook("preHandler", async (req, res) => {
        const { util, logger } = gl
        const token = util.getCookie({ name: `${process.env.APP_NAME}_ut`, req })
        if (!token) return
        const { uid } = await util.decodeToken({ token })
        if (uid) req.uid = uid
    })
    app.get('/', (req, res) => {
        console.log(req.url)
        return gl.config.project.name
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
        const { event, data } = body
        if (event === 'login_success') {
            const { user } = gl
            await user.handleLoginSuccessful_fromCommonAPI(data)
        }
        return "ok"
    })
}
main()
