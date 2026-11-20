# 怎么把它发到 GitHub

代码已经打包成一个**完整可推送的本地 git 仓库**（分支 `main`，已 commit，已带 `.gitignore` / `LICENSE` / `SECURITY.md`），差的就是「一个你自己的 GitHub 账号 + 一个空仓库」。

## 一步不能省的原因

注册 GitHub 需要：邮箱验证码 + 人机验证（CAPTCHA）+ 设置密码。这三步只能你本人做——代注册别人的账号既做不到（验证码在我这儿没有通道），也违反 GitHub 条款。**除注册和建空仓库外，剩下的我都能替你做完。**

## 路径 A：你建好空仓库，把 token 给我（我推送）

1. 打开 <https://github.com/signup> 注册（用你的 QQ 邮箱即可），用户名建议 `YOURNAME`。
2. 右上角 `+` → **New repository** → 名称填 `career-planner` → **不要**勾 README / .gitignore / license（保持空仓库）→ Create。
3. 生成令牌：<https://github.com/settings/tokens> → **Generate new token (classic)** → 勾 `repo` 权限 → 有效期选 90 天 → 生成后复制 `ghp_...`。
4. 把用户名和令牌发给我，我执行推送并把仓库地址给你。

> 令牌等于临时密码，用完可以到同一页面 Revoke。别发到群里。

## 路径 B：你自己在终端跑三条命令

在本机终端（不是这个对话框）执行：

```bash
cd ~/career-planner
GIT=/Library/Developer/CommandLineTools/usr/bin/git

# 1) 关联远程仓库（把 YOURNAME 换成你的 GitHub 用户名）
$GIT remote add origin https://github.com/YOURNAME/career-planner.git

# 2) 设置提交身份（等宽对齐，用你 GitHub 的邮箱）
$GIT config user.name  "YOURNAME"
$GIT config user.email "你的GitHub邮箱"

# 3) 推送（会提示输入用户名 + 令牌当密码）
$GIT push -u origin main
```

> 本机 `/usr/bin/git` 因为 Xcode 许可未接受会报错，所以上面用 CommandLineTools 里的绝对路径。

## 推送完成后

- 仓库地址形如 `https://github.com/YOURNAME/career-planner`
- 建议在仓库 About 里填：`DSH 生涯规划插件：抓任务 → 排每日计划 → QQ/微信推送`
- 想发 Release：`git tag v1.0.0 && git push origin v1.0.0`，再把 `career-planner-source-1.0.0.zip` 传上去当源码包。

## 推之前请确认

- `~/.dsh/career-planner/`（个人画像、任务、计划、QQ 库副本、`dbkey.txt`）**不在**仓库里，已在 `.gitignore` 排除。
- 测试夹具里的 AppID / Secret 已脱敏为假值。
- 想公开你的专业、学校、目标这些内容吗？——它们只在 `~/.dsh/career-planner/` 与提示词里，不在代码里。`CONTRACT.md` 是内部工程约定，如果不想公开可以直接删掉再推。
