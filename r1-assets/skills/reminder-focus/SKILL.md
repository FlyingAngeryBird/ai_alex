---
name: reminder-focus
description: "创建、查询、改期或取消一次性提醒及约定回访，并控制一段本地专注计时。适用于明确时间或时长的委托；不提供周期或退出后的云调度。"
---

# reminder-focus

## 负责的产物与动作
创建Reminder或Focus。提醒写入dueAt、timezone和scheduleVersion；Focus有实际剩余量与状态。到期由本地调度器决定，模型仅组织表达。
## 必要输入
读取用户原话、currentTime、系统timezone、已设晚间默认时间、事项内容和已知对象ID。提醒需具体日期时刻；专注需时长，未指定可用已声明默认25分钟。
## 执行指导
- “明晚”无具体时刻且无默认设置时问几点；时间已过时澄清，不自行移到明天。结果卡展示具体本地日期和时间。
- 创建提醒时 sourceRefs 只引用用户提出提醒/时间的真实messageId或AppContext.turnId；网页sourceRef是查询事实来源，不能证明用户的时间与授权，不填进提醒sourceRefs。关联已有便签使用真实itemId，不把便签ID/网页引用当用户原话引用。
- linkPurpose=todo_due只适用于真实todo到期提醒；阅读普通note的关联提醒使用other或independent，不能因为用户说“提醒”就把便签当todo。
- 关联便签用itemId；普通提醒或一次性回访用kind区分，回访必须先有明确约定。
- 改期或取消前，通过reminders_list读取对应提醒的当前reminderId、scheduleVersion与状态；不要从先前自然语言回复猜ID或版本，也不要要求用户提供内部ID。按用户描述筛选唯一对象；有多个合理对象才澄清。改期更新原ID，不新建替代。
- Reminder和Task是独立对象：reminderId只用于reminders_*工具，不能传给cancel_task/pause_task等任务工具；follow_up仍是提醒，不是后台Task。
- 取消只把原提醒置为cancelled，保留记录，不是删除数据；成功后说明已取消，不能声称已删除。已投递的通知不能声称撤回。每次只按实际回执确认；失败时不改称成功，也不以重复创建来试错。
- 专注同时只运行一段；已有活动段时询问停止旧段还是继续，不自动覆盖。pause/resume/stop使用现有focusId与version。
- 音乐动作独立调用music-companion；专注开始、暂停或结束不隐式操控音乐。明确关联规则才允许组合。
## 完成与失败
真实保存或计时启动才完成。本版调度范围是应用运行且Mac清醒；睡眠与退出后不承诺准时，恢复按错过规则呈现，专注恢复暂停。
## 示例参考
相对日期、缺时刻、改期竞态和已有专注时，读取[示例](references/examples.md)。

## 本版子技能范围

| 子技能 | 实现逻辑与输入 | 输出与边界 |
| --- | --- | --- |
| SK04.1 时间解析 | 原话、currentTime、系统timezone、可选晚间默认时间 | 形成dueAt并显示具体日期；“晚上”无设置则问几点，过去时间澄清 |
| SK04.2 创建与关联 | 内容、dueAt、可选itemId、kind | kind为普通提醒或一次性回访；有itemId则关联，不复制原便签 |
| SK04.3 改期与取消 | reminderId、expectedVersion、目标时间或取消指令 | 更新原ID与scheduleVersion；并发到期按真实投递状态处理 |
| SK04.4 专注控制 | 时长或focusId、expectedVersion；可选结束音乐规则 | start/pause/resume/stop；同时只一段活动专注，睡眠或退出恢复暂停 |
| SK04.5 到期表达 | 调度已触发事件、交谈与勿扰状态 | 静默卡片或合适空隙语音；调度器确定到期，模型只组织表达 |
