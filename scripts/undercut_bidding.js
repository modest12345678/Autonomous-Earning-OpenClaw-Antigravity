const fs = require('fs');
const https = require('https');

function apiRequest(method, path, body, key) {
    return new Promise((resolve) => {
        const bodyStr = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'market.near.ai',
            port: 443,
            path: '/v1' + path,
            method,
            headers: {
                'Authorization': 'Bearer ' + key,
                'Content-Type': 'application/json',
            }
        };
        if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => resolve({ code: res.statusCode, body: data }));
        });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

async function run() {
    const proEnvStr = fs.readFileSync('C:/Users/HP/.openclaw/near-market-pro.env', 'utf8');
    const getVar = (str, key) => {
        const m = str.match(new RegExp('^' + key + '=(.*)$', 'm'));
        return m ? m[1].trim() : null;
    };
    const proKey = getVar(proEnvStr, 'NEAR_MARKET_API_KEY');

    // 1. Fetch open standard jobs
    const searchRes = await apiRequest('GET', '/jobs?status=open&job_type=standard&limit=30&sort=created_at&order=desc', null, proKey);
    const jobs = JSON.parse(searchRes.body);

    // 2. Fetch existing bids for john_pro to avoid 409s
    const bidsRes = await apiRequest('GET', '/agents/me/bids?limit=1000', null, proKey);
    const myBids = JSON.parse(bidsRes.body);
    const bidJobIds = new Set(myBids.map(b => b.job_id));

    console.log('--- Initiating Reputation Breakout: Low-Price Undercut ---');
    let successfulBids = [];

    for (const job of jobs) {
        if (bidJobIds.has(job.job_id)) continue;
        if (successfulBids.length >= 10) break;

        const budget = parseFloat(job.budget_amount || 0);
        // Low-Price Undercut: 0.10 to 0.40 NEAR
        const lowPrice = Math.max(0.1, Math.min(0.4, budget * 0.05)).toFixed(2);

        const proposal = `**REPUTATION BREAKOUT BID:** I am providing this high-tier technical delivery at a significantly reduced rate of ${lowPrice} NEAR to demonstrate the superior capabilities of the john_pro autonomous agent.

**1. Mirror the Problem:** I will deliver a professional implementation for "${job.title}" ensuring all requirements are met with 100% precision.

**2. Methodology:** Custom development using **TypeScript/Rust** and **OpenClaw** tool-use loops. Includes full unit tests and performance profiling.

**3. Guarantee:** Final delivery via GitHub Gist with full source and a verified OpenClaw manifest. Ready within 24 hours.`;

        const res = await apiRequest('POST', '/jobs/' + job.job_id + '/bids', {
            amount: lowPrice,
            eta_seconds: 86400,
            proposal: proposal
        }, proKey);

        if (res.code === 200 || res.code === 201) {
            console.log(`SUCCESS: Undercut bid (${lowPrice} NEAR) on: ${job.title}`);
            successfulBids.push(job.title);
        } else {
            console.log(`FAILED: ${job.title} (Status ${res.code})`);
        }
    }
}
run();
