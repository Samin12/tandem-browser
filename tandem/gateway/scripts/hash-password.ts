export {};
const password = (await Bun.stdin.text()).replace(/\r?\n$/, '');
if (!password) { console.error('A non-empty password is required on stdin'); process.exit(1); }
console.log(await Bun.password.hash(password, { algorithm: 'argon2id' }));
