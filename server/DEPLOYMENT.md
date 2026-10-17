# 部署方案

## 最简单的 ECS 部署

原型阶段可以直接在服务器上运行：

```bash
git clone <仓库地址>
cd LocalMark
docker compose -f server/docker-compose.yml up -d --build
curl http://127.0.0.1:8000/api/health
```

数据库文件位于 Docker volume `localmark-data` 中。生产前需要把它替换成 PostgreSQL，或至少安排 SQLite 文件备份。

## 外部访问方案

### 方案一：Cloudflare Tunnel

在现有 cloudflared 配置中新增：

```yaml
ingress:
  - hostname: api.humensmoc.com
    service: http://127.0.0.1:8000
  - hostname: stats.humensmoc.com
    service: http://127.0.0.1:<umami-port>
  - service: http_status:404
```

这种方式不需要额外开放 API 入站端口，适合延续当前服务器结构。

### 方案二：公网 IP + Caddy

DNS 的 `api.humensmoc.com` 指向 ECS 公网 IP，Caddy 读取 `server/Caddyfile.example` 的反向代理配置并自动管理 HTTPS。此时安全组只开放 80 和 443，8000 只允许本机访问。

### 方案三：公网 IP + Nginx

Nginx 负责反向代理，另配 Certbot 或其他 ACME 客户端申请证书。它更常见、资料更多，但 HTTPS 和证书续期需要更多配置。

## Caddy、Nginx 和 Tunnel 的关系

- Caddy/Nginx：服务器上的反向代理，负责接收 HTTP/HTTPS 请求并转发到 API；
- Cloudflare Tunnel：从服务器主动连到 Cloudflare 的访问通道；
- 三者不是同一种东西，也不一定同时使用；
- 可以是 Tunnel → API，也可以是 Caddy → API，也可以是 Tunnel → Caddy → API。

当前原型推荐先使用：

```text
Cloudflare Tunnel → 127.0.0.1:8000
```

稳定后再决定是否改为：

```text
公网 DNS → Caddy → 127.0.0.1:8000
```
