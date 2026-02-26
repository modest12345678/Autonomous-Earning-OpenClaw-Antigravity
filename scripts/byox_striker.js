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
    const ironEnvStr = fs.readFileSync('C:/Users/HP/.openclaw/near-market.env', 'utf8');
    const proEnvStr = fs.readFileSync('C:/Users/HP/.openclaw/near-market-pro.env', 'utf8');
    const getVar = (str, key) => {
        const m = str.match(new RegExp('^' + key + '=(.*)$', 'm'));
        return m ? m[1].trim() : null;
    };
    const ironKey = getVar(ironEnvStr, 'NEAR_MARKET_API_KEY');
    const proKey = getVar(proEnvStr, 'NEAR_MARKET_API_KEY');

    // 1. Fetch all open jobs
    const resJobs = await apiRequest('GET', '/jobs?status=open&job_type=standard&limit=50', null, ironKey);
    const jobs = JSON.parse(resJobs.body);

    // 2. Fetch existing bids to avoid 409
    const bidsRes = await apiRequest('GET', '/agents/me/bids?limit=1000', null, ironKey);
    const myBids = JSON.parse(bidsRes.body);
    const bidJobIds = new Set(myBids.map(b => b.job_id));

    // BYOX Skill Mapping
    const byoxMapping = [
        { terms: ['blockchain', 'cryptocurrency', 'token', 'staking', 'consensus'], skill: 'Build-Your-Own-Blockchain' },
        { terms: ['ai', 'llm', 'rag', 'neural', 'inference', 'embedding'], skill: 'Build-Your-Own-AI' },
        { terms: ['database', 'redis', 'key-value', 'sql', 'store'], skill: 'Build-Your-Own-Database' },
        { terms: ['bot', 'discord', 'telegram', 'slack', 'automation', 'cli'], skill: 'Build-Your-Own-Bot/CLI' },
        { terms: ['search', 'scraper', 'indexing', 'tf-idf', 'vector'], skill: 'Build-Your-Own-Search-Engine' }
    ];

    console.log('--- Initiating BYOX Elite Strikes ---');
    let strikeCount = 0;

    for (const job of jobs) {
        if (bidJobIds.has(job.job_id)) continue;
        if (strikeCount >= 5) break;

        const text = (job.title + ' ' + (job.description || '')).toLowerCase();
        const match = byoxMapping.find(m => m.terms.some(t => text.includes(t)));

        if (match) {
            const budget = parseFloat(job.budget_amount || 1.0);
            const bidAmount = (budget * 0.4).toFixed(2); // Aggressive pricing

            const proposal = `**BYOX ELITE STRIKE:** I am applying a first-principles engineering approach for "${job.title}", leveraging methodology from the "Build-Your-Own-X" framework.

**1. Mirror the Problem:** Recommending a custom, ground-up implementation to ensure maximum efficiency and 100% control over the logic path.

**2. Methodology:** Engineered using **${match.skill}** principles. I will build the core engine in **Rust/TypeScript** from scratch to avoid dependency bloat and maximize performance.

**3. Guarantee:** Delivery includes a highly optimized GitHub repository, professional documentation, and verified unit tests. Ready in 24-48 hours.`;

            const res = await apiRequest('POST', '/jobs/' + job.job_id + '/bids', {
                amount: bidAmount,
                eta_seconds: 172800,
                proposal: proposal
            }, ironKey);

            if (res.code === 200 || res.code === 201) {
                console.log(`SUCCESS: BYOX bid on "${job.title}" using ${match.skill} logic.`);
                strikeCount++;
            }
        }
    }
}
run();
