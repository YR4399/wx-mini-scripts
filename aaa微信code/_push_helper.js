process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// ========== 推送通知模块 ==========
const axios = require('axios');

// PushPlus Token
const PLUSPLUS_TOKEN = process.env.PLUSPLUS_TOKEN || '';

async function sendPushNotify(title, content) {
    if (!PLUSPLUS_TOKEN) return false;
    try {
        const r = await axios.post('http://www.pushplus.plus/send', {
            token: PLUSPLUS_TOKEN, title, content, template: 'txt'
        }, { timeout: 10000 });
        if (r.data?.code === 200) console.log('✅ PushPlus推送成功: ' + title);
        else console.log('⚠️ PushPlus: ' + JSON.stringify(r.data));
        return true;
    } catch (e) {
        console.log('❌ PushPlus推送失败: ' + e.message);
        return false;
    }
}

module.exports = { sendPushNotify };
// ========== 推送通知模块结束 ==========
