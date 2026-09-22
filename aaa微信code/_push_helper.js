require("https").globalAgent.options.rejectUnauthorized = false;
// ========== 推送通知模块 ==========

async function sendPushNotify(title, content) {
    try {
        const { sendPush } = require("./std_report");
        return await sendPush(title, content);
    } catch (e) {
        console.log('❌ 钉钉推送失败: ' + e.message);
        return false;
    }
}

module.exports = { sendPushNotify };
// ========== 推送通知模块结束 ==========
