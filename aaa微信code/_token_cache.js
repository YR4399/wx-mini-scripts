// 通用 token 缓存模块
const fs = require("fs");
const path = require("path");

class TokenCache {
    constructor(cacheFile) {
        this.file = cacheFile;
    }

    read(key) {
        try {
            if (fs.existsSync(this.file)) {
                const cache = JSON.parse(fs.readFileSync(this.file, "utf-8"));
                return cache[key] || null;
            }
        } catch (_) {}
        return null;
    }

    save(key, token) {
        try {
            let cache = {};
            if (fs.existsSync(this.file)) {
                cache = JSON.parse(fs.readFileSync(this.file, "utf-8"));
            }
            cache[key] = { token, ts: Date.now() };
            fs.writeFileSync(this.file, JSON.stringify(cache));
        } catch (_) {}
    }

    remove(key) {
        try {
            if (fs.existsSync(this.file)) {
                const cache = JSON.parse(fs.readFileSync(this.file, "utf-8"));
                delete cache[key];
                fs.writeFileSync(this.file, JSON.stringify(cache));
            }
        } catch (_) {}
    }
}

module.exports = TokenCache;
