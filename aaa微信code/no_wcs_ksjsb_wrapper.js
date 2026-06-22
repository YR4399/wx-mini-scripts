const { execSync } = require('child_process');
let output;
try {
    output = execSync('node /app/Dumb-Panel/scripts/ksjsb_v2.js 2>&1', {
        encoding: 'utf8', timeout: 600000,
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
    });
} catch (e) {
    output = (e.stdout || e.stderr || '').toString();
    if (!output || output.length < 100) {
        console.log('ksjsb异常，请检查ksck配置');
        process.exit(0);
    }
}

for (const line of output.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    if (/^安装|^🔔|^\{|^'|^wechat|^⚠️/.test(s)) continue;
    if (/开始测试|API测试|脚本配置汇总|执行任务:|^⚡|^═══|^📋|^🚀|^设置并发|执行第.*批/.test(s)) continue;
    if (/通知发送|NODE_TLS|node --trace|Center|=====/.test(s)) continue;
    if (/缺失.*默认值|代理不存在.*直连|获取设备标识/.test(s)) continue;
    if (/^✅ API|^════|^执行任务|^⚡ 无延迟/.test(s)) continue;
    if (/^\(node:|^通知发送完成|^\[进程/.test(s)) continue;
    if (/^─{3,}/.test(s)) continue;
    console.log(s);
}
