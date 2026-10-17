---
name: capture-item
description: "按明确委托保存原话或整理内容，拆分待办，维护对象并导出TXT/MD。适用于记下来、列待办、修改保存内容；不自动创建提醒。"
---

# capture-item

## 负责的产物与动作
创建或修改本地Item，type为note或todo，返回真实itemId/version。导出写出用户选择的TXT/MD文件；Task或Artifact不等于已保存的Item。
## 必要输入
取得明确委托、内容范围、sourceRef、当前选中对象或最新artifactVersion。关键对象不唯一先澄清；不得保存与目标无关的整段会话。
## 执行指导
- “把我刚才原话记下”用original模式，保留原话；“整理后记下”用organized模式，可去赘述和分段，不添加事实。
- 待办拆成独立todo对象，每条保留创建回执；部分失败保留已成功条目。普通便签不允许勾选完成，普通待办不自动通知。
- 修改、完成撤销与删除使用已有itemId和expectedVersion；冲突先读取最新对象，再依据用户原委托处理或澄清。不得覆盖页面新编辑。
- 删除Item后，已经单独创建的Reminder仍存在；返回关联提醒供用户决定，不能自动取消。
- 导出调用notes.export，由UI打开保存选择。awaiting_user表示尚未导出；只有文件写入succeeded才说已导出，用户关闭选择则cancelled。
- 当前搜索候选的原样保存使用 notes_create.candidateTarget，四个身份/版本取 currentCandidate，type=note、mode=original；程序保存真实来源内容并与页面按钮复用同一Item，不采用模型content替换候选事实。普通原话/整理内容省略该字段；Task不使用会话选中对象字段。保存成功后以返回itemId关联提醒，提醒失败不得重建便签。
## 完成与失败
以数据库或文件回执为准。正文与标题遵守L01/L02，超限保留原内容并要求分段，不能静默截断。相同动作重试沿用程序的幂等标识。
## 组合
对工作产物明确保存时读取最新版；需要提醒时再调用reminder-focus，不把一个Item复制成多份替代关联。
## 示例参考
原文、整理保存、冲突与取消导出时，读取[示例](references/examples.md)。

## 本版子技能范围

| 子技能 | 实现逻辑与输入 | 输出与边界 |
| --- | --- | --- |
| SK03.1 引用与取材 | 当前选中内容、最近产物或明确原话；定位sourceRef | 只取明确范围；多个“这个”先澄清，不能保存整段无关对话 |
| SK03.2 原文与整理 | 保存模式original或organized，标题与正文 | 原文保留文字；整理不新增事实；标题上限L02、正文L01 |
| SK03.3 待办拆分 | 明确“列待办”或选中清单 | 每项有独立itemId及完成状态；普通待办不自带到期通知 |
| SK03.4 对象维护 | itemId、expectedVersion、patch或完成状态 | 修改同一对象；并发冲突先读取，不能覆盖页面新编辑 |
| SK03.5 保存与导出 | artifactId、artifactVersion或具体itemIds | 转为本地便签/待办，或导出TXT/MD；用户取消文件选择即取消 |
