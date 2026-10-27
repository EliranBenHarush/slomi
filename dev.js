// Local run with in-memory DB (data is lost on restart). Password: 1234
process.env.USE_PG_MEM = '1';
process.env.APP_PASSWORD = process.env.APP_PASSWORD || '1234';
require('./server');
