// ========== 推送通知模块 ==========
const axios = require('axios');

// PushPlus Token
const PLUSPLUS_TOKEN = process.env.PLUSPLUS_TOKEN || '';

async function sendPushNotify(title, content) {
    if (!PLUSPLUS_TOKEN) {
        console.log('⚠️ 未配置PLUSPLUS_TOKEN，跳过推送');
        return false;
    }
    try {
        await axios.post('https://www.pushplus.plus/send', {
            token: PLUSPLUS_TOKEN,
            title: title,
            content: content,
            template: 'txt'
        }, { 
            timeout: 10000,
            proxy: false  // 禁用代理
        });
        console.log('✅ PushPlus推送成功: ' + title);
        return true;
    } catch (e) {
        console.log('❌ PushPlus推送失败: ' + e.message);
        return false;
    }
}

module.exports = { sendPushNotify };
// ========== 推送通知模块结束 ==========
