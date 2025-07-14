import pg from 'pg';
import { BaseService } from './common/baseService.js';

const { Pool } = pg;

export class DB extends BaseService {
    /**
     * 初始化数据库连接
     * @param {Object} gl - 全局对象
     * @returns {Promise<string|null>} 错误信息或null
     */
    async init(gl) {
        try {
            const { logger } = gl;
            this.pool = null;
            this.isConnected = false;
            // 优先使用 connectionString，如果没有则使用分离的配置参数
            const connectionString = process.env.DB_URL;
            if (!connectionString) {
                return '数据库连接字符串未配置';
            }
            let dbConfig;
            // 使用连接字符串
            dbConfig = {
                connectionString,
                max: parseInt(process.env.DB_POOL_MAX) || 20,
                idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
                connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 2000,
            };

            logger.info('使用连接字符串创建数据库连接池', {
                connectionString: connectionString.replace(/\/\/[^@]*@/, '//***:***@'), // 隐藏密码
                poolMax: dbConfig.max
            });

            // 创建连接池
            this.pool = new Pool(dbConfig);

            // 监听连接池事件
            this.pool.on('connect', (client) => {
                logger.debug('新的数据库客户端连接', { processId: client.processID });
            });

            this.pool.on('error', (err, client) => {
                logger.error('数据库连接池错误', { error: err.message, stack: err.stack });
            });

            this.pool.on('remove', (client) => {
                logger.debug('数据库客户端连接移除', { processId: client.processID });
            });

            // 测试连接
            await this.testConnection();
            this.isConnected = true;

            logger.info('数据库连接池初始化成功');
            return null;
        } catch (error) {
            return `数据库初始化失败: ${error.message}`;
        }
    }

    /**
     * 测试数据库连接
     */
    async testConnection() {
        const client = await this.pool.connect();
        try {
            const result = await client.query('SELECT NOW() as current_time, version() as version');
            this.gl.logger.info('数据库连接测试成功', {
                currentTime: result.rows[0].current_time,
                version: result.rows[0].version.split(' ')[0]
            });
        } finally {
            client.release();
        }
    }

    /**
     * 执行查询
     * @param {string} text - SQL查询语句
     * @param {Array} params - 查询参数
     * @returns {Promise<Object>} 查询结果
     */
    async query(text, params = []) {
        const start = Date.now();
        try {
            const result = await this.pool.query(text, params);
            const duration = Date.now() - start;

            this.gl.logger.debug('数据库查询执行', {
                sql: text,
                params,
                duration: `${duration}ms`,
                rowCount: result.rowCount
            });

            return result;
        } catch (error) {
            const duration = Date.now() - start;
            this.gl.logger.error('数据库查询失败', {
                sql: text,
                params,
                duration: `${duration}ms`,
                error: error.message,
                code: error.code
            });
            throw error;
        }
    }

    /**
     * 执行事务
     * @param {Function} callback - 事务回调函数
     * @returns {Promise<any>} 事务结果
     */
    async transaction(callback) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            this.gl.logger.debug('开始数据库事务');

            const result = await callback(client);

            await client.query('COMMIT');
            this.gl.logger.debug('数据库事务提交成功');

            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            this.gl.logger.error('数据库事务回滚', {
                error: error.message,
                code: error.code
            });
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 获取单个记录
     * @param {string} text - SQL查询语句
     * @param {Array} params - 查询参数
     * @returns {Promise<Object|null>} 单个记录或null
     */
    async findOne(text, params = []) {
        const result = await this.query(text, params);
        return result.rows.length > 0 ? result.rows[0] : null;
    }

    /**
     * 获取多个记录
     * @param {string} text - SQL查询语句
     * @param {Array} params - 查询参数
     * @returns {Promise<Array>} 记录数组
     */
    async findMany(text, params = []) {
        const result = await this.query(text, params);
        return result.rows;
    }

    /**
     * 插入记录
     * @param {string} table - 表名
     * @param {Object} data - 插入的数据
     * @returns {Promise<Object>} 插入的记录
     */
    async insert(table, data) {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');

        const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
        const result = await this.query(sql, values);

        return result.rows[0];
    }

    /**
     * 更新记录
     * @param {string} table - 表名
     * @param {Object} data - 更新的数据
     * @param {Object} where - 更新条件
     * @returns {Promise<Object>} 更新的记录
     */
    async update(table, data, where) {
        const dataKeys = Object.keys(data);
        const dataValues = Object.values(data);
        const whereKeys = Object.keys(where);
        const whereValues = Object.values(where);

        const setClause = dataKeys.map((key, index) => `${key} = $${index + 1}`).join(', ');
        const whereClause = whereKeys.map((key, index) => `${key} = $${dataKeys.length + index + 1}`).join(' AND ');

        const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING *`;
        const result = await this.query(sql, [...dataValues, ...whereValues]);

        return result.rows[0];
    }

    /**
     * 删除记录
     * @param {string} table - 表名
     * @param {Object} where - 删除条件
     * @returns {Promise<number>} 删除的记录数
     */
    async delete(table, where) {
        const whereKeys = Object.keys(where);
        const whereValues = Object.values(where);
        const whereClause = whereKeys.map((key, index) => `${key} = $${index + 1}`).join(' AND ');

        const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
        const result = await this.query(sql, whereValues);

        return result.rowCount;
    }

    /**
     * 检查表是否存在
     * @param {string} tableName - 表名
     * @returns {Promise<boolean>} 表是否存在
     */
    async tableExists(tableName) {
        const sql = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = $1
      )
    `;
        const result = await this.query(sql, [tableName]);
        return result.rows[0].exists;
    }

    /**
     * 执行数据库迁移脚本
     * @param {string} migrationSql - 迁移SQL脚本
     * @returns {Promise<void>}
     */
    async migrate(migrationSql) {
        await this.transaction(async (client) => {
            this.gl.logger.info('执行数据库迁移');
            await client.query(migrationSql);
            this.gl.logger.info('数据库迁移完成');
        });
    }

    /**
     * 获取连接池状态
     * @returns {Object} 连接池状态信息
     */
    getPoolStatus() {
        return {
            totalCount: this.pool.totalCount,
            idleCount: this.pool.idleCount,
            waitingCount: this.pool.waitingCount,
            isConnected: this.isConnected
        };
    }

    /**
     * 关闭数据库连接池
     */
    async close() {
        if (this.pool) {
            this.gl.logger.info('关闭数据库连接池');
            await this.pool.end();
            this.isConnected = false;
            this.gl.logger.info('数据库连接池已关闭');
        }
    }

    /**
     * 注册健康检查端点
     * @param {Object} app - Fastify应用实例
     */
    async regEndpoints(app) {
        // 数据库健康检查端点
        app.get('/health/db', async (request, reply) => {
            try {
                await this.testConnection();
                const status = this.getPoolStatus();

                reply.send({
                    status: 'healthy',
                    database: 'postgresql',
                    connected: this.isConnected,
                    pool: status,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                this.gl.logger.error('数据库健康检查失败', { error: error.message });
                reply.code(503).send({
                    status: 'unhealthy',
                    database: 'postgresql',
                    connected: false,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        });

        // 数据库连接池状态端点
        app.get('/status/db-pool', async (request, reply) => {
            const status = this.getPoolStatus();
            reply.send({
                pool: status,
                timestamp: new Date().toISOString()
            });
        });
    }
}

export default DB;