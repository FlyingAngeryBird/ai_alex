# 实时对话配置后的真实鉴权联调

变更ID：DEC-R1-NATIVE-AUTH-028。父提交`5e65e54`。依据最终PRD F01、F11c、G0；继续在R1独立工作树推进，原目录不写入。SQLite10、资产2.5.1、模型/端点/鉴权协议和Prompt/Skill/工具合同不变。

## 真实结果

用户2026-10-16确认已安装并保存实时3.0 API Key及默认音色。通过CUA读取实际运行包`51f50e2`：两项均显示已配置，文字模型和搜索仍未配置。

在正式包设置中点击「检测实时对话」，实际结果为「鉴权失败，请检查密钥与服务权限」，对应REALTIME_AUTH_FAILED。顶部始终「麦克风未开启」。只进行会话建立/关闭检测，没有发送麦克风音频、用户正文或工具请求，没有把保存成功当连接成功。

当前旧包未公开HTTP数字及供应商原始内容，不能判定是无效密钥、密钥来源错误、项目不一致还是服务权限缺失。已向用户询问Key来源，未要求发送密钥；没有替换或清除用户保存的凭据。

## 官方核对

- [官方iOS双工SDK说明](https://docs.volcengine.com/docs/DoubaoVoice/end-to-end-full-duplex-ios-sdk-documentation?lang=zh)使用独立`/api/v3/duplex/realtime/dialogue`及API Key配置，与当前接入地址一致。
- [语音API Key使用](https://docs.volcengine.com/docs/DoubaoVoice/APIKeyUsage?lang=zh)说明新版语音控制台的X-Api-Key鉴权与API管理入口。
- [语音控制台指引](https://docs.volcengine.com/docs/DoubaoVoice/console-guidance?lang=zh)说明Key、模型开通和资源均以项目隔离。应先核对Key所属项目是否已开通目标服务。
- 原生3.0正文页面本次仅返回JS壳/超时，未假称已重读完整正文；既有协议依据保留在2026-10-13-provider-protocol-progress.md。没有根据第三方教程擅改协议、增加旧版回退或换供应商。

## 修复与验证

发现live transport把所有JSON error事件都归为REALTIME_SERVER_REJECTED，而检测transport对鉴权已有分类。两者统一稳定分类函数；仅接收已识别数字错误码，未知/对象/供应商原始message不透传。鉴权不自动重连，429显示服务限额，避免正式会话和检测显示不同原因。

设置增加Key来源及同项目开通指引；未要求额外权限或自动创建/更换凭据。真实已安装旧包保持运行；此次分类/文案源码修改尚未打包安装，不能说用户已看到新文案。

关联4测试文件33项通过：检测与live在session建立前后相同分类、私密报文不透传、终止后不发送音频、原有恢复和取消。生产构建通过，保留既有bundle体积提示。日志`/tmp/seamo-r1-20261016-auth-tests.log`及`/tmp/seamo-r1-20261016-auth-build.log`。

## 下一步

确认语音Key来源及所属项目开通权限后，在原已安装包重试会话检测；通过后再测实际连续交流、工具回注与打断。音色兼容尚未经过会话建立验证，不根据外形或TTS试听作成功判断。原生功能仍未验收，其他未配置服务分别保持未配置；无G阶段通过标签或正式Release。

## 同日补充：安全握手诊断（DEC-R1-NATIVE-AUTH-029）

用户明确Key来自「豆包语音新版控制台→API Key管理」，不再反复询问来源。进一步定位需要区分HTTP握手失败和session事件失败，因此增加可选诊断details；不更改实际端点/请求头/模型参数。

details只允许phase、HTTP数字、数字服务码、格式受限的服务关联ID及固定枚举原因。错误体最多读取16KiB/1秒，仅分类明确的资源未授权或Key无效短语；其他内容全部丢弃，不传原始message、body、headers或凭据。诊断导出再次过滤，取消/超时仍由原检测流程控制。设置可显示握手阶段和HTTP/服务码。

关联3文件21项及生产构建通过；新增测试覆盖分块响应、过大/非JSON/私密正文、流异常和有界超时。此前分类修复33项仍为关联证据。准备在保留R1凭据的开发包中复测，实际结果待下一条记录；尚不声称资源权限是根因。父源码回退`9c6e63e`，SQLite10和资产2.5.1不变，无正式Release或阶段通过标签。
