// Local run with in-memory DB (data is lost on restart). Password: 1234
process.env.USE_PG_MEM = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || '1234';
process.env.CHROME_PATH = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Short path: Chrome's profile breaks under very long Windows paths
process.env.WA_DATA_PATH = process.env.WA_DATA_PATH || require('path').join(require('os').tmpdir(), 'debts-wa');
require('./server');
