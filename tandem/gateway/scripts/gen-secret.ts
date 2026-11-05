import { randomBytes } from 'node:crypto';
import { encodeBase32, randomToken } from '../src/security';
const secret = encodeBase32(randomBytes(20));
console.log(`Agent token: ${randomToken()}`);
console.log(`TOTP secret: ${secret}`);
console.log(`otpauth://totp/Tandem%20Browser:owner?secret=${secret}&issuer=Tandem%20Browser&algorithm=SHA1&digits=6&period=30`);
