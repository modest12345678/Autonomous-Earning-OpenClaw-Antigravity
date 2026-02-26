const { execSync } = require('child_process');
const fs = require('fs');

/**
 * Intelligent Kilo Model Switcher
 * Prioritizes Kimi 2.5 (minimax), then falls back to other high-performance free models.
 */
const FREE_MODELS = [
    'kilo/minimax/minimax-m2.5:free', // Kimi 2.5 (Primary)
    'kilo/z-ai/glm-5:free',           // GLM-5 (Elite Fallback)
    'kilo/stepfun/step-3.5-flash:free',// Step 3.5 (Speed Fallback)
    'kilo/arcee-ai/trinity-large-preview:free',
    'kilo/corethink:free'
];

function runKiloCommand(workDir, promptFile) {
    for (const model of FREE_MODELS) {
        try {
            console.log(`[KILO-ROUTER] Attempting build with model: ${model}`);
            const kiloCmd = `powershell -Command "cd '${workDir}'; C:\\Users\\HP\\AppData\\Roaming\\npm\\kilo.cmd run -m ${model} --prompt (Get-Content '${promptFile}' -Raw)"`;
            
            const output = execSync(kiloCmd, { 
                timeout: 600000, 
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'] 
            });
            
            console.log(`[KILO-ROUTER] Success with ${model}`);
            return output;
        } catch (e) {
            console.warn(`[KILO-ROUTER] Model ${model} failed or rate-limited. Switching...`);
            continue; 
        }
    }
    throw new Error("All free Kilo models exhausted or failed.");
}

module.exports = { runKiloCommand };
