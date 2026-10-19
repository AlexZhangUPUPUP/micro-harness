# 003：README Star 引导动画

## 目标

制作点击 GitHub 仓库 Star 按钮的循环 GIF，用于 README 引导读者支持 micro-harness；保持朱砂橙品牌。

## 场景与验收条件

1. 动图展示 micro-harness 仓库画面、光标移向 Star 按钮、点击反馈与 Starred 状态，循环播放。
2. 使用朱砂橙品牌色 `#F07855 → #C84B37`；画面简洁，按钮与光标清晰可见。
3. 动画由本地画面合成，不实际点击 GitHub Star 按钮，不更改任何账号的 Star 状态；不伪造增长指标。
4. 中英文 README 引用同一 `docs/star.gif`，图片链接到 `https://github.com/AlexZhangUPUPUP/micro-harness`，支持读者自行访问并决定是否 Star。
5. 产品静态截图分别使用 `docs/gui.png` 与 `docs/gui-zh.png`，放在功能列表后、章节导航前，与 Star 引导分开。
6. 文档站正确复制 GIF 资源，替代文字明确说明星标引导内容。

## 实施与验证

- 本地合成 GIF，不新增生产依赖，不调用模型或修改外部账号。
- 检查 GIF 的尺寸、帧数、循环、文件大小及关键帧；检查 README 链接与文档构建资源。
- 保留已有未提交修改，不自动提交或推送。
