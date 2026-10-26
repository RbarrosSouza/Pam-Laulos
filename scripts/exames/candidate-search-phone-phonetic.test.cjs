const test = require('node:test');
const assert = require('node:assert/strict');

test('candidate phone and phonetic search validation', () => {
  // Test phonetic variant expansion
  const expandTerm = (term) => {
    const variants = new Set();
    variants.add(term);
    if (/qui/i.test(term)) {
      variants.add(term.replace(/qui/gi, 'ki'));
      variants.add(term.replace(/qui/gi, 'chi'));
    }
    if (/ki/i.test(term)) {
      variants.add(term.replace(/ki/gi, 'qui'));
      variants.add(term.replace(/ki/gi, 'chi'));
    }
    if (/chi/i.test(term)) {
      variants.add(term.replace(/chi/gi, 'ki'));
      variants.add(term.replace(/chi/gi, 'qui'));
    }
    const digits = term.replace(/\D/g, '');
    if (digits.length >= 4) {
      variants.add(digits);
    }
    return Array.from(variants);
  };

  const quiaraVariants = expandTerm('quiara');
  assert.ok(quiaraVariants.includes('quiara'));
  assert.ok(quiaraVariants.includes('kiara'));
  assert.ok(quiaraVariants.includes('chiara'));

  const phoneVariants = expandTerm('(16) 99190-6624');
  assert.ok(phoneVariants.includes('16991906624'));
  assert.ok(phoneVariants.includes('(16) 99190-6624'));
});
