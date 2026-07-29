#!/usr/bin/env node
// ============================================
// 电信等级权益自动兑换脚本（整合dxlin三参数登录版）
// 兼容格式：dxlin环境变量 手机号#密码#AndroidID@手机号2#密码2
// 接口新版无需瑞数，保留旧兑换策略
// 新增：PushPlus微信推送
// ============================================

// ========== npm 依赖 ==========
const axios = require('axios')
const CryptoJS = require('crypto-js')
const crypto = require('crypto')
const JSEncrypt = require('node-jsencrypt')
const fs = require('fs')

// ========== PushPlus推送配置 新增 ==========
const PUSH_PLUS_TOKEN = process.env.PUSH_PLUS_TOKEN || ''
let globalLogs = []
const originConsoleLog = console.log
// 重写日志，全部存入数组用于推送
console.log = function (...args) {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false })
    const logStr = `[${ts}] ${args.join(' ')}`
    globalLogs.push(logStr)
    originConsoleLog(logStr)
}

// PushPlus推送方法
async function pushSend(title) {
    if (!PUSH_PLUS_TOKEN || globalLogs.length === 0) return
    const content = globalLogs.join('\n')
    try {
        await axios.post('http://www.pushplus.plus/send', {
            token: PUSH_PLUS_TOKEN,
            title: title,
            content: content,
            template: 'txt'
        })
        console.log("✅ PushPlus推送完成")
    } catch (err) {
        console.log(`❌ PushPlus推送失败：${err.message}`)
    }
}

// 判断是否测试模式
const isTest = process.argv.includes('test')

// ========== 加密密钥（与Python脚本完全对齐） ==========
// 3DES 密钥（24字节）
const DES3_KEY = '1234567`90koiuyhgtfrdews'
const DES3_IV = '\0\0\0\0\0\0\0\0'

// RSA 公钥（登录加密用）
const RSA_PUB_KEY_LOGIN = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDBkLT15ThVgz6/NOl6s8GNPofdWzWbCkWnkaAm7O2LjkM1H7dMvzkiqdxU02jamGRHLX/ZNMCXHnPcW/sDhiFCBN18qFvy8g6VYb9QtroI09e176s+ZCtiv7hbin2cCTj99iUpnEloZm19lwHyo69u5UMiPMpq0/XKBO8lYhN/gwIDAQAB
-----END PUBLIC KEY-----`

// RSA 公钥（请求参数加密用）
const RSA_PUB_KEY_DATA = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC+ugG5A8cZ3FqUKDwM57GM4io6JGcStivT8UdGt67PEOihLZTw3P7371+N47PrmsCpnTRzbTgcupKtUv8ImZalYk65dU8rjC/ridwhw9ffW2LBwvkEnDkkKKRi2liWIItDftJVBiWOh17o6gfbPoNrWORcAdcbpk2L+udld5kZNwIDAQAB
-----END PUBLIC KEY-----`

// ========== 账号配置（改用dxlin，三参数：手机号#密码#AndroidID） ==========
let userPhone = []
if (process.env.dxlin) {
    // 支持@、换行分割多账号
    process.env.dxlin.split(/[@&\n]/).map(item => {
        const line = item.trim()
        if (!line || line.split('#').length !== 3) return
        const [phone, password, androidId] = line.split('#').map(v => v.trim())
        if (phone && password && androidId) {
            userPhone.push({ phone, password, androidId })
        }
    })
} else {
    console.log('未找到环境变量 dxlin')
    console.log('账号格式: 手机号#密码#AndroidID@手机号2#密码2#AndroidID2')
    console.log('AndroidID 从云链小栈小程序获取')
    ;(async () => {
        await pushSend("电信脚本异常：缺少dxlin环境变量")
        process.exit(1)
    })()
}

// ========== 状态管理 ==========
let Cache = {}
let runArr = []

// 加载缓存
function loadCache() {
    try {
        Cache = JSON.parse(fs.readFileSync('./Cache.json', 'utf8'))
    } catch (error) {
        Cache = {}
        saveCache()
    }
}

// 保存缓存
function saveCache() {
    fs.writeFileSync('./Cache.json', JSON.stringify(Cache, null, 2), 'utf8')
}

// ========== 工具函数 ==========
function randomString(length) {
    const chars = 'abcdef0123456789'
    let result = ''
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
}

function getTimestamp() {
    const date = new Date()
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    const h = String(date.getHours()).padStart(2, '0')
    const min = String(date.getMinutes()).padStart(2, '0')
    const s = String(date.getSeconds()).padStart(2, '0')
    return `${y}${m}${d}${h}${min}${s}`
}

function maskPhone(phone) {
    return phone.replace(/^(\d{3})(\d*)(\d{4})$/, "$1****$3")
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// 字符串编码（每个字符+2，和Python encode函数一致）
function encodeStr(text) {
    let result = ''
    for (let i = 0; i < text.length; i++) {
        result += String.fromCharCode(text.charCodeAt(i) + 2)
    }
    return result
}

// ========== 3DES 加密解密（对齐Python逻辑） ==========
function des3Encrypt(text) {
    const key = CryptoJS.enc.Utf8.parse(DES3_KEY)
    const iv = CryptoJS.enc.Utf8.parse(DES3_IV)
    const encrypted = CryptoJS.TripleDES.encrypt(
        CryptoJS.enc.Utf8.parse(text),
        key,
        {
            iv: iv,
            mode: CryptoJS.mode.CBC,
            padding: CryptoJS.pad.Pkcs7
        }
    )
    return encrypted.ciphertext.toString()
}

function des3Decrypt(text) {
    const key = CryptoJS.enc.Utf8.parse(DES3_KEY)
    const iv = CryptoJS.enc.Utf8.parse(DES3_IV)
    const ciphertext = CryptoJS.enc.Hex.parse(text)
    const decrypted = CryptoJS.TripleDES.decrypt(
        { ciphertext: ciphertext },
        key,
        {
            iv: iv,
            mode: CryptoJS.mode.CBC,
            padding: CryptoJS.pad.Pkcs7
        }
    )
    return decrypted.toString(CryptoJS.enc.Utf8)
}

// ========== RSA 加密 ==========
// RSA 登录加密 返回base64（对齐Python encrypt_rsa login b64模式）
function rsaEncryptLogin(plaintext) {
    const encrypt = new JSEncrypt()
    encrypt.setPublicKey(RSA_PUB_KEY_LOGIN)
    return encrypt.encrypt(plaintext)
}

// RSA 分段加密 参数用 返回hex（对齐Python data rsa）
function rsaEncryptData(plaintext) {
    if (typeof plaintext !== 'string') {
        plaintext = JSON.stringify(plaintext)
    }

    const publicKey = crypto.createPublicKey(RSA_PUB_KEY_DATA)
    const keySize = 128
    const maxChunkSize = keySize - 11
    const plaintextBytes = Buffer.from(plaintext, 'utf8')
    let ciphertext = Buffer.alloc(0)

    for (let i = 0; i < plaintextBytes.length; i += maxChunkSize) {
        const chunk = plaintextBytes.slice(i, i + maxChunkSize)
        const encryptedChunk = crypto.publicEncrypt({
            key: publicKey,
            padding: crypto.constants.RSA_PKCS1_PADDING
        }, chunk)
        ciphertext = Buffer.concat([ciphertext, encryptedChunk])
    }

    return ciphertext.toString('hex')
}

// ========== 登录相关【核心改造：接收androidId三参数登录】 ==========
async function loginPhone(phone, password, androidId, retryCount = 0) {
    if (retryCount >= 3) {
        console.log(`[${maskPhone(phone)}] 登录重试次数过多，放弃`)
        return false
    }

    try {
        const timestamp = getTimestamp()
        // 对齐Python登录加密明文：Xiaomi 20 8.0.0.{androidId前12位}{phone}{ts}{pwd}0$$$0.
        const cutAndroidId = androidId.slice(0, 12)
        const loginPlain = `Xiaomi 20 8.0.0.${cutAndroidId}${phone}${timestamp}${password}0$$$0.`
        const loginAuthCipherAsymmertric = rsaEncryptLogin(loginPlain)

        const data = {
            headerInfos: {
                code: 'userLoginNormal',
                timestamp: timestamp,
                broadAccount: '',
                broadToken: '',
                clientType: '#11.0.0#channel8#Xiaomi 20#',
                shopId: '20002',
                source: '110003',
                sourcePassword: 'Sid98s',
                token: '',
                userLoginName: encodeStr(phone)
            },
            content: {
                attach: 'test',
                fieldData: {
                    loginType: '4',
                    accountType: '',
                    loginAuthCipherAsymmertric: loginAuthCipherAsymmertric,
                    deviceUid: '',
                    phoneNum: encodeStr(phone),
                    isChinatelecom: '',
                    systemVersion: '8.0.0',
                    androidId: encodeStr(androidId),
                    loginAuthCipher: '',
                    authentication: encodeStr(password)
                }
            }
        }

        if (!Cache[phone]) {
            const res = await axios({
                url: 'https://appgologin.189.cn:9031/login/client/userLoginNormal',
                method: 'POST',
                data,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 12; zh-cn) AppleWebKit/533.1 (KHTML, like Gecko) Version/5.0 Mobile Safari/533.1'
                }
            })

            const result = res.data.responseData?.data?.loginSuccessResult
            if (!result) {
                console.log(`[${maskPhone(phone)}] 登录响应异常:`, JSON.stringify(res.data).substring(0, 200))
                return false
            }

            Cache[phone] = { ...result }
            saveCache()
            console.log(`[${maskPhone(phone)}] 登录成功`)
        }

        const userToken = Cache[phone].token
        const userId = Cache[phone].userId

        if (!userToken || !userId) {
            console.log(`[${maskPhone(phone)}] 缓存数据无效，重新登录`)
            delete Cache[phone]
            saveCache()
            return await loginPhone(phone, password, androidId, retryCount + 1)
        }

        // 获取 ticket
        const ticket = await getTicket(phone, userId, userToken)

        if (!ticket) {
            console.log(`[${maskPhone(phone)}] ticket 获取失败，重新登录...`)
            delete Cache[phone]
            saveCache()
            return await loginPhone(phone, password, androidId, retryCount + 1)
        }

        return {
            ...Cache[phone],
            ticket,
            password,
            phoneNbr: phone
        }
    } catch (e) {
        console.log(`[${maskPhone(phone)}] 登录失败:`, e.message)
        return false
    }
}

// 获取 ticket（逻辑完全保留）
async function getTicket(phone, userId, token) {
    try {
        const timestamp = getTimestamp()
        const targetId = des3Encrypt(userId)

        const xmlData = `<Request>
<HeaderInfos>
<Code>getSingle</Code>
<Timestamp>${timestamp}</Timestamp>
<BroadAccount></BroadAccount>
<BroadToken></BroadToken>
<ClientType>#9.6.1#channel50#iPhone 14 Pro Max#</ClientType>
<ShopId>20002</ShopId>
<Source>110003</Source>
<SourcePassword>Sid98s</SourcePassword>
<Token>${token}</Token>
<UserLoginName>${phone}</UserLoginName>
</HeaderInfos>
<Content>
<Attach>test</Attach>
<FieldData>
<TargetId>${targetId}</TargetId>
<Url>4a6862274835b451</Url>
</FieldData>
</Content>
</Request>`

        const res = await axios({
            url: 'https://appgologin.189.cn:9031/map/clientXML',
            method: 'POST',
            data: xmlData,
            headers: {
                'Content-Type': 'application/xml;charset=utf-8',
                'User-Agent': 'CtClient;10.4.1;Android;13;22081212C;NTQzNzgx!#!MTgwNTg1'
            }
        })

        const match = res.data.match(/<Ticket>(.*?)<\/Ticket>/)
        if (!match) {
            console.log(`[${maskPhone(phone)}] 获取 ticket 失败，响应:`, res.data.substring(0, 200))
            return false
        }

        const ticketEncrypted = match[1]
        const ticket = des3Decrypt(ticketEncrypted)
        return ticket
    } catch (e) {
        console.log(`[${maskPhone(phone)}] 获取 ticket 失败:`, e.message)
        return false
    }
}

// SSO 登录，获取 sign 和 accId（无修改）
async function ssoHomLogin(ticket) {
    try {
        const res = await axios({
            url: 'https://wappark.189.cn/jt-sign/ssoHomLogin?ticket=' + ticket,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 13; 22081212C Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.97 Mobile Safari/537.36'
            }
        })

        if (res.data.resoultCode === '0') {
            return {
                sign: res.data.sign,
                accId: res.data.accId
            }
        } else {
            console.log('获取 sign 失败:', res.data.resoultMsg)
            return false
        }
    } catch (e) {
        console.log('获取 sign 失败:', e.message)
        return false
    }
}

// ========== 权益相关（原逻辑完全不动） ==========
// 获取等级权益列表
async function getLevelRightsList(sign, accId) {
    try {
        const value = {
            type: 'hg_qd_djqydh',
            accId: accId,
            shopId: '20001'
        }

        const paraV = rsaEncryptData(value)

        const res = await axios({
            url: 'https://wappark.189.cn/jt-sign/paradise/queryLevelRightInfo',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Linux; Android 13; 22081212C Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.97 Mobile Safari/537.36',
                'sign': sign
            },
            data: { para: paraV }
        })

        const data = res.data
        if (data.code === 401) {
            console.log('获取权益失败: sign 过期')
            return null
        }

        const currentLevel = data.currentLevel
        const keyName = 'V' + currentLevel
        const rights = data[keyName] || []

        // 筛选话费权益
        const phoneRights = rights.filter(item =>
            item.title && item.title.includes('话费')
        )

        return phoneRights
    } catch (e) {
        console.log('获取权益列表失败:', e.message)
        return null
    }
}

// 检查权益状态
async function getState(sign, accId, rightsId, phone) {
    try {
        const value = {
            id: rightsId,
            accId: accId,
            showType: '9003',
            showEffect: '8',
            czValue: '0'
        }

        const paraV = rsaEncryptData(value)

        const res = await axios({
            url: 'https://wappark.189.cn/jt-sign/paradise/receiverRights',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Linux; Android 13; 22081212C Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.97 Mobile Safari/537.36',
                'sign': sign
            },
            data: { para: paraV }
        })

        const resultText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)

        if (resultText.includes('已兑换') || resultText.includes('已领取')) {
            console.log(`[${maskPhone(phone)}] ${rightsId} 已兑换`)
            return true
        } else {
            console.log(`[${maskPhone(phone)}] ${rightsId} 待兑换`)
            return false
        }
    } catch (e) {
        console.log(`[${maskPhone(phone)}] 检查状态失败:`, e.message)
        return false
    }
}

// 执行兑换（重试版）
function getConversionRights(sign, accId, rightsId, phone, number = 1) {
    return new Promise(async (resolve) => {
        if (number >= 50) {
            console.log(`[${maskPhone(phone)}] 达到最大重试次数`)
            resolve(false)
            return
        }

        try {
            const value = {
                id: rightsId,
                accId: accId,
                showType: '9003',
                showEffect: '8',
                czValue: '0'
            }

            const paraV = rsaEncryptData(value)

            const res = await axios({
                url: 'https://wappark.189.cn/jt-sign/paradise/receiverRights',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; 22081212C Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.97 Mobile Safari/537.36',
                    'sign': sign
                },
                data: { para: paraV },
                timeout: 5000
            })

            const resultText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)

            if (resultText.includes('兑换成功') || res.data.resoultCode === '0' || res.data.code === 0) {
                console.log(`[${maskPhone(phone)}] 兑换成功~`)
                resolve(true)
                return
            } else if (resultText.includes('已兑换') || resultText.includes('已领取')) {
                console.log(`[${maskPhone(phone)}] 权益已兑换~`)
                resolve(true)
                return
            } else if (resultText.includes('库存不足') || resultText.includes('已抢完') || resultText.includes('售罄')) {
                console.log(`[${maskPhone(phone)}] 库存不足~`)
                resolve(false)
                return
            } else if (resultText.includes('金豆不足')) {
                console.log(`[${maskPhone(phone)}] 金豆不足`)
                resolve(false)
                return
            } else {
                // 继续重试
                setTimeout(() => {
                    getConversionRights(sign, accId, rightsId, phone, number + 1).then(resolve)
                }, 900)
            }
        } catch (e) {
            // 请求失败，继续重试
            setTimeout(() => {
                getConversionRights(sign, accId, rightsId, phone, number + 1).then(resolve)
            }, 900)
        }
    })
}

// ========== 主流程（改造：传入androidId） ==========
// 单账号主流程
async function main(phone, password, androidId) {
    const userinfo = await loginPhone(phone, password, androidId)
    if (!userinfo) return

    const signData = await ssoHomLogin(userinfo.ticket)
    if (!signData) return

    const rightsList = await getLevelRightsList(signData.sign, signData.accId)
    if (!rightsList || rightsList.length === 0) {
        console.log(`[${maskPhone(phone)}] 未找到话费权益`)
        return
    }

    for (const item of rightsList) {
        const exchanged = await getState(signData.sign, signData.accId, item.activityId, phone)
        if (!exchanged) {
            runArr.push({
                phone,
                sign: signData.sign,
                accId: signData.accId,
                rightsId: item.activityId,
                title: item.title
            })
        }
    }
}

// 初始化所有账号（循环传递三参数）
async function getUser() {
    loadCache()
    console.log('获取账号成功', userPhone.length)
    console.log()

    for (let i = 0; i < userPhone.length; i++) {
        const item = userPhone[i]
        await main(item.phone, item.password, item.androidId)
        if (i < userPhone.length - 1) {
            await wait(5000) // 每个账号间隔 5 秒
        }
    }

    console.log()
    console.log(`所有账号初始化完成，共 ${runArr.length} 个待兑换任务`)
}

// 等待到指定时间执行
function waitForSpecificTime(callback) {
    const now = new Date()
    const targetTime = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23, 59, 59, 500
    )

    if (now >= targetTime) {
        targetTime.setDate(targetTime.getDate() + 1)
    }

    const timeDifference = targetTime - now
    console.log(`等待 ${Math.floor(timeDifference / 1000)} 秒后执行兑换...`)

    setTimeout(callback, timeDifference)
}

// 执行所有兑换任务
async function run() {
    console.log('开始执行兑换任务，共', runArr.length, '个')
    console.log()

    const taskList = runArr.map(item => getConversionRights(item.sign, item.accId, item.rightsId, item.phone))
    await Promise.all(taskList)

    console.log("\n全部兑换流程执行完毕")
    await pushSend("电信等级权益 零点兑换汇总")
}

// ========== 启动入口（改造增加测试模式推送、异常捕获推送） ==========
(async function start() {
    console.log('========================================')
    console.log('  电信等级权益自动兑换脚本（dxlin三参数整合版）')
    console.log('  环境变量 dxlin：手机号#密码#AndroidID')
    if (isTest) console.log('🧪 当前为测试模式，仅登录校验不等待零点兑换')
    console.log('========================================')
    console.log()

    try {
        await getUser()

        // 测试模式：直接推送日志退出
        if (isTest) {
            console.log("\n🧪 账号校验完成，测试脚本结束")
            await pushSend("电信等级权益 测试校验汇总")
            process.exit(0)
        }

        // 正常模式等待零点兑换
        waitForSpecificTime(run)
    } catch (err) {
        console.log(`💥 脚本全局异常：${err.stack || err.message}`)
        await pushSend("电信等级权益脚本运行异常通知")
        process.exit(1)
    }
})()