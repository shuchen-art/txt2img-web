# 部署指南（GitHub Pages + Cloudflare Workers）

本方案完全免费、无需购买服务器或数据库，且**完全保留本地 `python run.py` 开发方式**。

- **前端（GitHub Pages）**：托管 [static/](static) 静态文件，地址为 `https://<你的GitHub用户名>.github.io/<仓库名>/`。
- **后端（Cloudflare Worker + SQLite Durable Objects）**：托管 `/api/sessions*` 接口、DeepSeek API 请求、隐藏题面与邮箱白名单校验，密钥与名单不进入 GitHub 仓库。

---

## 第一步：部署 Cloudflare Worker 后端

1. 登录或注册免费的 [Cloudflare](https://dash.cloudflare.com/) 账号。
2. 在本机安装依赖并登录 Wrangler：
   ```sh
   cd worker
   npm install
   npx wrangler login
   ```
3. 在 [worker/wrangler.toml](worker/wrangler.toml) 中填入你的 GitHub Pages 域名（**只写协议和域名，不要带仓库路径或末尾斜杠**）：
   ```toml
   ALLOWED_ORIGINS = "https://<你的GitHub用户名>.github.io"
   ```
4. 配置两个加密环境变量（不会保存在代码仓库中）：
   ```sh
   npx wrangler secret put DS_API_KEY
   # 粘贴你的 DeepSeek API Key 后回车

   npx wrangler secret put ALLOWLIST
   # 输入白名单，例如：cleavcw@hkust-gz.edu.cn:Human #83791
   ```
5. 部署上线：
   ```sh
   npx wrangler deploy
   ```
   部署成功后，终端会输出后端地址，例如：
   `https://txt2img-api.<你的子域>.workers.dev`

---

## 第二步：推送代码并开启 GitHub Pages

1. 在 GitHub 上新建一个仓库（免费版 GitHub Pages 需设为 Public；仓库内不含 `.env` 和 `allowlist.csv`），在项目根目录推送代码：
   ```sh
   cd ..
   git remote add origin https://github.com/<你的GitHub用户名>/<仓库名>.git
   git add .
   git commit -m "Deploy txt2img-web to GitHub Pages + Cloudflare Workers"
   git push -u origin main
   ```
2. 打开 GitHub 仓库页面 → **Settings** → **Secrets and variables** → **Actions** → 切换到 **Variables** 标签页 → 点击 **New repository variable**：
   - **Name**：`API_BASE`
   - **Value**：填入第一步获得的 Worker 地址（如 `https://txt2img-api.<你的子域>.workers.dev`，末尾不要加 `/`）
3. 打开 **Settings** → **Pages** → **Build and deployment** → **Source** 选择 **GitHub Actions**。
4. 若刚才推送时还没配置 `API_BASE`，到 **Actions** 标签页重新运行一次 `Deploy GitHub Pages` 工作流即可。部署完成后打开页面顶部给出的 `https://<你的GitHub用户名>.github.io/<仓库名>/`。

---

## 第三步：日常增删白名单邮箱（Cloudflare 网页后台直接修改）

无需改代码或重新部署，打开 Cloudflare Dashboard：
**Workers & Pages** → **`txt2img-api`** → **Settings** → **Variables and Secrets** → 编辑 `ALLOWLIST`（支持以下任意格式）：

- **单行分号分隔（推荐在网页输入框使用）**：
  ```text
  cleavcw@hkust-gz.edu.cn:Human #83791; friend@example.com:Human #00002
  ```
- **省略编号自动生成固定 `Human #XXXXX`**：
  ```text
  cleavcw@hkust-gz.edu.cn:Human #83791; friend@example.com
  ```
- **多行 CSV**：
  ```csv
  email,human_id
  cleavcw@hkust-gz.edu.cn,Human #83791
  friend@example.com,Human #00002
  ```

保存后立即生效，对应邮箱输入后点击 `[ START ]` 即可一步开始并绑定指定 `MODEL_ID`。

---

## 本地开发说明

本地访问 `http://127.0.0.1:8000` 时，前端会自动忽略 `API_BASE`，继续走同源的本地 Python 服务（读取 `.env` 与 [allowlist.csv](allowlist.csv)）：

```sh
.venv/bin/python run.py
```
