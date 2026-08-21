/** Frozen user-visible card semantics. Dynamic transport IDs are excluded. */
export const UI_CONTRACT = {
  reply: {
    loading: {
      schema: '2.0',
      wide: true,
      updateMulti: true,
      padding: '0px 16px 14px 16px',
      spacing: '12px',
      status: "20:13 · 0s · <text_tag color='neutral'>处理中</text_tag>",
      main: '⠋ **正在分析**',
      skeleton: true,
    },
    completed: {
      schema: '2.0',
      wide: true,
      updateMulti: true,
      padding: '0px 16px 14px 16px',
      spacing: '12px',
      status: "20:13 · 0s · <text_tag color='green'>已完成</text_tag>",
      answerTitle: '**结论**',
      main: '答案',
      analysisTitle: '🔍 **分析过程**',
      analysisExpanded: false,
    },
    failed: {
      schema: '2.0',
      wide: true,
      updateMulti: true,
      padding: '0px 16px 14px 16px',
      spacing: '12px',
      status: "20:13 · 0s · <text_tag color='red'>失败</text_tag>",
      title: '**分析失败：boom**',
      errorTone: 'red',
      actions: [
        { label: '↻ 重试', type: 'primary', kind: 'dsh-feishu-channel/retry' },
        { label: '复制错误', type: 'default', kind: 'dsh-feishu-channel/copy-error' },
      ],
    },
  },
  approval: {
    pending: {
      wide: true,
      status: "**操作审批**  <text_tag color='orange'>待确认</text_tag>",
      fields: [{ label: '**工具**', value: 'bash' }],
      sections: [
        { label: '**将执行**', value: 'pnpm test' },
        { label: '**模型说明**', value: '需要执行测试' },
      ],
      note: '批准前请确认上面的内容确实是你要执行的。',
      actions: [
        { label: '允许一次', type: 'primary', decision: 'allow' },
        { label: '拒绝', type: 'danger', decision: 'reject' },
      ],
    },
    settled: {
      wide: true,
      status: "**操作审批**  <text_tag color='green'>已允许</text_tag>",
      fields: [{ label: '**工具**', value: 'bash' }],
      note: '操作人：Jiahao',
      actions: [],
    },
  },
  command: {
    success: {
      wide: true,
      status: "**命令执行**  <text_tag color='green'>已完成</text_tag>",
      fields: [{ label: '**命令**', value: '/stop' }],
      text: '已停止当前任务。',
    },
    help: {
      wide: true,
      status: "**命令中心**  <text_tag color='blue'>可用</text_tag>",
      placeholder: '选择命令',
      options: ['/new · 新建会话', '/model · 查看或更换当前会话模型'],
      note: '选择后将在当前卡片中打开对应操作。',
    },
    confirm: {
      wide: true,
      status: "**命令确认**  <text_tag color='orange'>待确认</text_tag>",
      fields: [
        { label: '**命令**', value: '/compact' },
        { label: '**作用**', value: '压缩较早的会话历史' },
      ],
      actions: [
        { label: '执行命令', type: 'primary', action: 'run' },
        { label: '取消', type: 'default', action: 'cancel' },
      ],
    },
    input: {
      wide: true,
      status: "**命令确认**  <text_tag color='orange'>待输入</text_tag>",
      fields: [
        { label: '**命令**', value: '/feedback' },
        { label: '**作用**', value: '记录反馈' },
      ],
      placeholder: '<text>',
      submit: '执行',
    },
  },
  permission: {
    picker: {
      wide: true,
      status: "**权限设置**  <text_tag color='blue'>请选择</text_tag>",
      fields: [{ label: '**当前权限**', value: 'workspace-write' }],
      placeholder: '选择权限预设',
      options: ['Workspace write', 'Full access'],
      note: '选择后将作用于当前会话；高风险权限需要再次确认。',
    },
  },
  model: {
    picker: {
      wide: true,
      status: "**模型设置**  <text_tag color='blue'>请选择</text_tag>",
      fields: [
        { label: '**当前模型**', value: 'deepseek-v4-flash' },
        { label: '**提供方**', value: 'deepseek-official' },
      ],
      placeholder: '选择模型',
      options: ['DeepSeek V4 Flash · DeepSeek', 'DeepSeek V4 Pro · DeepSeek'],
      note: '选择后将作用于当前会话的下一条消息。',
    },
    settled: {
      wide: true,
      status: "**推理强度**  <text_tag color='green'>已完成</text_tag>",
      fields: [{ label: '**当前强度**', value: 'max' }],
      actions: [],
    },
  },
} as const
