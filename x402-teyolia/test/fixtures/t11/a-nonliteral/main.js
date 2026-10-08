// T-11a negativo: import() con especificador no literal (no verificable -> falla cerrado).
const target = './' + 'x.js';
await import(target);
