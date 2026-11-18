# DeepSeek Box

面向 Android 的 API 聊天客户端。无需应用账号，配置兼容 OpenAI Chat Completions 的 API 地址、模型名称和 API Key 后即可使用。

## 功能

- ChatGPT 风格的移动聊天界面
- 用户消息靠右、AI 回复靠左
- Markdown、表格和代码块渲染
- DeepSeek 深度思考与联网搜索
- 自定义 API 地址、模型名称和 API Key
- 本机保存会话与 API 配置

## Android 构建

需要 Node.js 22、pnpm、JDK 21 和 Android SDK。

```powershell
pnpm install
pnpm run android:assets
pnpm run android:sync
cd android
./gradlew assembleDebug
```

APK 输出在 `android/app/build/outputs/apk/debug/app-debug.apk`。

## API 设置

默认使用 `https://api.deepseek.com` 和 `deepseek-flash`。联网搜索与深度思考由 DeepSeek API 提供，使用这些功能可能产生相应的模型及搜索费用。其他 OpenAI Chat Completions 兼容服务可在应用设置中填写地址、模型和 Key。

## 社区

- QQ 群：[加入群聊](https://qm.qq.com/q/SaZ0OFHYgQ)
- GitHub：[Jiaozi06/deepseek-box](https://github.com/Jiaozi06/deepseek-box)

版权：© Jiaozi

## 许可

本项目遵循仓库中的 GNU GPL v3 许可。移动客户端构建沿用 Chatbox Community Edition 的开源构建与依赖基础，并新增独立的 Android 聊天界面。请一并遵守原项目及所用依赖各自的许可条款。
