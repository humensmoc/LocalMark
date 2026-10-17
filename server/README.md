# LocalMark 云端同步最小原型

这个目录是一个可直接启动的后端原型，用于验证：

- 注册与登录；
- Bearer 登录会话；
- 网页 JSON 创建、读取和更新；
- 使用 `If-Match` revision 检查并返回 `409 Conflict`；
- 两个浏览器标签页同时编辑时的冲突选择数据。

原型只使用 Python 标准库和 SQLite，不代表最终生产技术栈。稳定后可以把 HTTP Handler 迁移为 FastAPI，把 SQLite 迁移为 PostgreSQL，接口契约保持不变。

## 本地运行

```bash
python3 server/app.py
```

然后打开 <http://127.0.0.1:8000>。

冲突测试：

1. 打开两个标签页；
2. 两边登录同一个账号；
3. 两边都点击“读取服务器版本”；
4. 在两个标签页分别修改内容；
5. 先保存其中一个；
6. 再保存另一个，第二个会得到 `409`，其中包含 `serverData`、`clientData` 和两个 revision。

## 接口

```text
POST /api/auth/register
POST /api/auth/login
GET  /api/me
POST /api/pages
GET  /api/pages/{page_id}
PUT  /api/pages/{page_id}       If-Match: <revision>
GET  /api/health
```

## 安全边界

这是测试原型，不应直接暴露到公网：生产环境需要 HTTPS、正式反向代理、限流、邮箱验证、密码重置、CSRF 策略、日志脱敏和数据库备份。
