#!/usr/bin/env node
/**
 * 独立扫码注册脚本：为"用环境变量管理凭据"的部署走一遍官方 QR 注册流程
 * （插件首启的 onboard 跑的是同一流程）。打印扫码 URL，扫码用户在飞书里
 * 确认创建应用（平台的基础模板已含 bot 能力、消息 scope 与事件订阅），
 * 然后把产出的凭据导出为环境变量：
 *
 *   node scripts/register-lark-app.mjs
 *
 * 导出后把两个变量填进 cordis.patch.yml 的 appId / appSecret：
 *   appId: !!js process.env.FEISHU_APP_ID
 *   appSecret: !!js process.env.FEISHU_APP_SECRET
 */
import { registerApp } from '@larksuite/channel'

const result = await registerApp({
  source: 'dsh-feishu-channel',
  appPreset: {
    name: 'DSH Agent',
    desc: 'DSH 会话机器人',
  },
  onQRCodeReady({ url, expireIn }) {
    console.log('\n用飞书扫码（或在已登录飞书的浏览器打开）创建应用，' + Math.round(expireIn / 60) + ' 分钟内有效：\n')
    console.log('  ' + url + '\n')
    console.log('等待扫码确认…')
  },
  onStatusChange({ status }) {
    if (status !== 'polling') console.error('[register] ' + status)
  },
})

console.log('\n应用创建成功，把凭证导出为环境变量：\n')
console.log('  export FEISHU_APP_ID=' + result.client_id)
console.log('  export FEISHU_APP_SECRET=' + result.client_secret)
const owner = result.user_info?.open_id
console.log(owner === undefined
  ? '\n扫码流程未返回扫码用户，请把可使用本机器人的 open id 配置到 feishu-channel 的 senderAllowlist。'
  : '\n扫码用户（可配置为 senderAllowlist / approvers）：' + owner)
