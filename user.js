import { BaseService } from './common/baseService.js';
import crypto from 'crypto';

export class User extends BaseService {
  constructor() {
    super();
    this.tableName = 'users';
  }

  /**
   * 初始化用户服务
   * @param {Object} gl - 全局对象
   * @returns {Promise<string|null>} 错误信息或null
   */
  async init(gl) {
    try {
      const { logger, db } = gl;

      if (!db) {
        return '数据库服务未初始化';
      }

      // 检查并创建users表
      await this.ensureUsersTable(db, logger);

      logger.info('用户服务初始化成功');
      return null;
    } catch (error) {
      return `用户服务初始化失败: ${error.message}`;
    }
  }

  /**
   * 确保users表存在
   * @param {Object} db - 数据库实例
   * @param {Object} logger - 日志实例
   */
  async ensureUsersTable(db, logger) {
    const tableExists = await db.tableExists(this.tableName);

    if (!tableExists) {
      logger.info('创建users表');

      const createTableSQL = `
        CREATE TABLE users (
          uid SERIAL PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          pass TEXT NOT NULL,
          "from" INTEGER DEFAULT 0,
          info JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          status INTEGER DEFAULT 1
        );
        
        -- 创建索引
        CREATE INDEX idx_users_email ON users(email);
        CREATE INDEX idx_users_status ON users(status);
        CREATE INDEX idx_users_from ON users("from");
        CREATE INDEX idx_users_created_at ON users(created_at);
        
        -- 创建更新时间触发器
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ language 'plpgsql';
        
        CREATE TRIGGER update_users_updated_at
          BEFORE UPDATE ON users
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
      `;

      await db.migrate(createTableSQL);
      logger.info('users表创建成功');
    }
  }

  /**
   * 密码加密
   * @param {string} password - 原始密码
   * @param {string} salt - 盐值（可选）
   * @returns {Object} 包含加密密码和盐值的对象
   */
  hashPassword(password, salt = null) {
    if (!salt) {
      salt = crypto.randomBytes(16).toString('hex');
    }

    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return {
      hash: `${salt}:${hash}`,
      salt
    };
  }

  /**
   * 验证密码
   * @param {string} password - 输入的密码
   * @param {string} hashedPassword - 存储的加密密码
   * @returns {boolean} 密码是否正确
   */
  verifyPassword(password, hashedPassword) {
    try {
      const [salt, hash] = hashedPassword.split(':');
      const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
      return hash === verifyHash;
    } catch (error) {
      this.gl.logger.error('密码验证失败', { error: error.message });
      return false;
    }
  }

  /**
   * 生成随机密码
   * @param {number} length - 密码长度，默认16位
   * @returns {string} 随机密码
   */
  generateRandomPassword(length = 16) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';

    for (let i = 0; i < length; i++) {
      const randomIndex = crypto.randomInt(0, charset.length);
      password += charset[randomIndex];
    }

    return password;
  }

  /**
   * 获取第三方应用名称
   * @param {number} from - 第三方应用ID
   * @returns {string} 应用名称
   */
  getFromName(from) {
    const fromMap = {
      1: 'Magic Link',
      2: 'Google',
      3: 'Maxthon'
    };

    return fromMap[from] || `Unknown(${from})`;
  }

  /**
   * 创建用户
   * @param {Object} userData - 用户数据
   * @returns {Promise<Object>} 创建的用户信息（不包含密码）
   */
  async createUser({ email, password, from = 0, info = {}, status = 1 }) {

    if (!email) {
      throw new Error('邮箱不能为空');
    }

    // 如果有from参数但没有password，生成随机密码
    let finalPassword = password;
    if (from && from > 0 && !password) {
      finalPassword = this.generateRandomPassword();
      this.gl.logger.info('为第三方用户生成随机密码', {
        email,
        from,
        fromName: this.getFromName(from)
      });
    } else if (!password) {
      throw new Error('密码不能为空');
    }

    // 检查邮箱是否已存在
    const existingUser = await this.gl.db.findOne(
      'SELECT uid FROM users WHERE email = $1',
      [email]
    );

    if (existingUser) {
      throw new Error('邮箱已被注册');
    }

    // 加密密码
    const { hash } = this.hashPassword(finalPassword);

    // 插入用户
    const newUser = await this.gl.db.insert('users', {
      email,
      pass: hash,
      from,
      info: JSON.stringify(info),
      status
    });

    this.gl.logger.info('用户创建成功', {
      uid: newUser.uid,
      email: newUser.email,
      from: newUser.from
    });

    // 返回用户信息（不包含密码）
    const { pass, ...userInfo } = newUser;
    return userInfo;
  }

  /**
   * 用户登录验证
   * @param {string} email - 邮箱
   * @param {string} password - 密码
   * @param {string} salt - one time login code
   * @returns {Promise<Object|null>} 用户信息或null
   */
  async authenticateUser({ salt, email, password }) {
    if (!salt && (!email || !password)) {
      throw new Error('邮箱和密码不能为空');
    }
    let verifyPass = true
    if (salt) {
      const { redis } = this.gl
      email = await redis.get(salt)
      await redis.del(salt)
      verifyPass = false
    }
    const user = await this.gl.db.findOne(
      'SELECT * FROM users WHERE email = $1 AND status = 1',
      [email]
    );

    if (!user) {
      this.gl.logger.warn('登录失败：用户不存在或已禁用', { email });
      return null;
    }
    if (verifyPass) {
      const isValidPassword = this.verifyPassword(password, user.pass);
      if (!isValidPassword) {
        this.gl.logger.warn('登录失败：密码错误', { email, uid: user.uid });
        return null;
      }
    }
    this.gl.logger.info('用户登录成功', {
      uid: user.uid,
      email: user.email
    });
    // 返回用户信息（不包含密码）
    const { pass, ...userInfo } = user;
    return userInfo;
  }

  /**
   * 根据邮箱或UID获取用户信息
   * @param {Object} params - 查询参数
   * @param {string} params.email - 邮箱（可选）
   * @param {number} params.uid - 用户ID（可选）
   * @returns {Promise<Object|null>} 用户信息或null
   */
  async getUser({ email, uid }) {
    if (!email && !uid) {
      throw new Error('必须提供邮箱或用户ID');
    }

    let query, params;

    if (uid) {
      query = 'SELECT uid, email, "from", info, created_at, updated_at, status FROM users WHERE uid = $1';
      params = [uid];
    } else {
      query = 'SELECT uid, email, "from", info, created_at, updated_at, status FROM users WHERE email = $1';
      params = [email];
    }

    const user = await this.gl.db.findOne(query, params);
    return user;
  }
  /**
   * 更新用户信息
   * @param {number} uid - 用户ID
   * @param {Object} updateData - 更新的数据
   * @returns {Promise<Object>} 更新后的用户信息
   */
  async updateUser(uid, updateData) {
    const allowedFields = ['email', 'from', 'info', 'status'];
    const updateFields = {};

    // 过滤允许更新的字段
    for (const field of allowedFields) {
      if (updateData.hasOwnProperty(field)) {
        if (field === 'info' && typeof updateData[field] === 'object') {
          updateFields[field] = JSON.stringify(updateData[field]);
        } else {
          updateFields[field] = updateData[field];
        }
      }
    }

    if (Object.keys(updateFields).length === 0) {
      throw new Error('没有有效的更新字段');
    }

    // 如果更新邮箱，检查是否已存在
    if (updateFields.email) {
      const existingUser = await this.gl.db.findOne(
        'SELECT uid FROM users WHERE email = $1 AND uid != $2',
        [updateFields.email, uid]
      );

      if (existingUser) {
        throw new Error('邮箱已被其他用户使用');
      }
    }

    const updatedUser = await this.gl.db.update('users', updateFields, { uid });

    if (!updatedUser) {
      throw new Error('用户不存在');
    }

    this.gl.logger.info('用户信息更新成功', {
      uid,
      updatedFields: Object.keys(updateFields)
    });

    // 返回用户信息（不包含密码）
    const { pass, ...userInfo } = updatedUser;
    return userInfo;
  }

  /**
   * 更新用户密码
   * @param {number} uid - 用户ID
   * @param {string} oldPassword - 旧密码
   * @param {string} newPassword - 新密码
   * @returns {Promise<boolean>} 是否更新成功
   */
  async updatePassword(uid, oldPassword, newPassword) {
    if (!oldPassword || !newPassword) {
      throw new Error('旧密码和新密码不能为空');
    }

    // 获取用户当前密码
    const user = await this.gl.db.findOne(
      'SELECT pass FROM users WHERE uid = $1',
      [uid]
    );

    if (!user) {
      throw new Error('用户不存在');
    }

    // 验证旧密码
    const isValidOldPassword = this.verifyPassword(oldPassword, user.pass);

    if (!isValidOldPassword) {
      throw new Error('旧密码错误');
    }

    // 加密新密码
    const { hash } = this.hashPassword(newPassword);

    // 更新密码
    await this.gl.db.update('users', { pass: hash }, { uid });

    this.gl.logger.info('用户密码更新成功', { uid });

    return true;
  }

  /**
   * 删除用户（软删除，设置status为0）
   * @param {number} uid - 用户ID
   * @returns {Promise<boolean>} 是否删除成功
   */
  async deleteUser(uid) {
    const result = await this.gl.db.update('users', { status: 0 }, { uid });

    if (!result) {
      throw new Error('用户不存在');
    }

    this.gl.logger.info('用户删除成功', { uid });

    return true;
  }

  /**
   * 确保用户存在，如果不存在则创建用户
   * @param {Object} userData - 用户数据
   * @param {string} userData.email - 邮箱（可选，如果提供uid则可不提供）
   * @param {number} userData.uid - 用户ID（可选，如果提供email则可不提供）
   * @param {string} userData.from - 第三方来源
   * @param {Object} userData.info - 用户信息（可选）
   * @returns {Promise<Object>} 用户信息
   */
  async ensureUser({ email, uid, from, info = {} }) {
    // 参数验证
    if (!email && !uid) {
      throw new Error('必须提供邮箱或用户ID');
    }

    let user = null;

    // 根据提供的参数查找用户
    user = await this.getUser({ email, uid });

    // 如果用户存在，返回用户信息
    if (user) {
      this.gl.logger.info('用户已存在', {
        uid: user.uid,
        email: user.email,
        from: user.from
      });
      return user;
    }

    // 如果用户不存在，创建新用户
    if (!email) {
      throw new Error('创建用户时邮箱不能为空');
    }

    // 如果是第三方用户且没有密码，会自动生成随机密码
    const newUser = await this.createUser({ email, from: from || 0, info });

    this.gl.logger.info('用户创建成功', { uid: newUser.uid, email: newUser.email, from: newUser.from, fromName: this.getFromName(newUser.from) });

    return newUser;
  }

  /**
   * 获取用户列表
   * @param {Object} options - 查询选项
   * @returns {Promise<Object>} 用户列表和分页信息
   */
  async getUserList(options = {}) {
    const { page = 1, limit = 20, status = null, from = null, search = null } = options;
    const offset = (page - 1) * limit;
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    // 构建查询条件
    if (status !== null) {
      whereClause += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    if (from !== null) {
      whereClause += ` AND "from" = $${paramIndex}`;
      params.push(from);
      paramIndex++;
    }
    if (search) {
      whereClause += ` AND email ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
      paramIndex++;
    }
    // 查询总数
    const countSQL = `SELECT COUNT(*) as total FROM users ${whereClause}`;
    const countResult = await this.gl.db.findOne(countSQL, params);
    const total = parseInt(countResult.total);

    // 查询用户列表
    const listSQL = `
      SELECT uid, email, "from", info, created_at, updated_at, status 
      FROM users 
      ${whereClause} 
      ORDER BY created_at DESC 
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const users = await this.gl.db.findMany(listSQL, [...params, limit, offset]);

    return { users, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }
  async handleLoginSuccessful_fromCommonAPI({ salt, ...rest }) {
    const { redis } = gl
    console.log("handleLoginSuccessful_fromCommonAPI", salt, rest)
    if (!salt) return { code: 100, err: "no salt" }
    const { type, email, picture } = rest
    if (type === 'google') {
      await this.ensureUser({ email, from: 1, info: { avatar: picture } })
    }
    redis.$r.set(salt, email, { EX: 60 * 5 })
    return { code: 0, msg: "ok" }
  }

  /**
   * 注册用户管理相关的API端点
   * @param {Object} app - Fastify应用实例
   */
  async regEndpoints(app) {
    // 用户注册
    app.post('/user/register', async (req, res) => {
      try {
        const { email, password, from, info } = req.body;
        const user = await this.createUser({ email, password, from, info });

        return { code: 0, result: user };
      } catch (error) {
        this.gl.logger.error('用户注册失败', { error: error.message, body: req.body });
        return { code: 100, err: error.message };
      }
    });

    // 用户登录
    app.post('/user/login', async (req, res) => {
      try {
        const { salt, email, password } = req.body;
        const user = await this.authenticateUser({ salt, email, password });

        if (!user) {
          return { code: 100, err: '邮箱或密码错误' };
        }
        return { code: 0, result: user };
      } catch (error) {
        this.gl.logger.error('用户登录失败', { error: error.message });
        return { code: 100, err: error.message };
      }
    });

    // 获取用户信息
    app.get('/user/:uid', async (req, res) => {
      try {
        const { uid } = req.params;
        const user = await this.getUser({ uid: parseInt(uid) });
        return user ? { code: 0, result: user } : { code: 100, err: '用户不存在' };
      } catch (error) {
        this.gl.logger.error('获取用户信息失败', { error: error.message, uid: req.params.uid });
        return { code: 100, err: '服务器错误' };
      }
    });

    // 更新用户信息
    app.post('/user/:uid/update', async (req, res) => {
      try {
        const { uid } = req.params;
        const updateData = req.body;

        const user = await this.updateUser(parseInt(uid), updateData);

        return { code: 0, result: user };
      } catch (error) {
        this.gl.logger.error('更新用户信息失败', { error: error.message, uid: req.params.uid });
        return { code: 100, err: error.message };
      }
    });

    // 更新用户密码
    app.post('/user/:uid/password', async (req, res) => {
      try {
        const { uid } = req.params;
        const { oldPassword, newPassword } = req.body;

        await this.updatePassword(parseInt(uid), oldPassword, newPassword);

        return { code: 0, result: { message: '密码更新成功' } };
      } catch (error) {
        this.gl.logger.error('更新密码失败', { error: error.message, uid: req.params.uid });
        return { code: 100, err: error.message };
      }
    });

    // 删除用户
    app.delete('/user/:uid', async (req, res) => {
      try {
        const { uid } = req.params;
        await this.deleteUser(parseInt(uid));

        return { code: 0, result: { message: '用户删除成功' } };
      } catch (error) {
        this.gl.logger.error('删除用户失败', { error: error.message, uid: req.params.uid });
        return { code: 100, err: error.message };
      }
    });

    // 获取用户列表
    app.get('/user', async (req, res) => {
      try {
        const { page, limit, status, from, search } = req.query;
        const result = await this.getUserList({
          page: page ? parseInt(page) : undefined,
          limit: limit ? parseInt(limit) : undefined,
          status: status !== undefined ? parseInt(status) : null,
          from: from !== undefined ? parseInt(from) : null,
          search
        });

        return { code: 0, result: result };
      } catch (error) {
        this.gl.logger.error('获取用户列表失败', { error: error.message });
        return { code: 100, err: '服务器错误' };
      }
    });
  }
}

export default User;