// Long options of `git commit` whose value is the next word unless written as `--option=value`.
const COMMIT_VALUE_OPTIONS = new Set([
  '--message', '--file', '--author', '--date', '--cleanup', '--trailer',
]);
// Short options whose value is the rest of the word, or the next word when they end it (`-m msg`, `-mmsg`, `-am msg`).
const SHORT_VALUE_OPTIONS = new Set(['m', 'F', 'C', 'c', 't']);
// Short options whose optional value can only be attached (`-S<keyid>`, `-u<mode>`).
const SHORT_ATTACHED_OPTIONS = new Set(['S', 'u']);

function shellCommandSegments(command) {
  const segments = [];
  let words = [];
  let word = '';
  let quote = '';
  let escaped = false;

  const pushWord = () => {
    if (word.length > 0) {
      words.push(word);
      word = '';
    }
  };
  const pushSegment = () => {
    pushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (const char of String(command ?? '')) {
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (escaped) {
        word += char;
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = '';
      } else {
        word += char;
      }
      continue;
    }
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '\n' || char === '\r') {
      pushSegment();
    } else if (/\s/.test(char)) {
      pushWord();
    } else if (char === ';' || char === '&' || char === '|') {
      pushSegment();
    } else {
      word += char;
    }
  }
  if (escaped) word += '\\';
  pushSegment();
  return segments;
}

function isShellAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word ?? '');
}

/**
 * The option letters of a short-option word, up to the first option that takes a value: the
 * rest of such a word is that option's value, so `-an` is a and n, but `-mnote` is m alone.
 * A word that is not a short-option cluster has no letters.
 */
function shortOptionLetters(word) {
  if (!/^-[A-Za-z]/.test(word)) return [];
  const letters = [];
  for (const letter of word.slice(1)) {
    letters.push(letter);
    if (SHORT_VALUE_OPTIONS.has(letter) || SHORT_ATTACHED_OPTIONS.has(letter)) break;
  }
  return letters;
}

/** True when a short-option word ends with a value option, so the next word is its value. */
function shortOptionTakesNextWord(word) {
  const letters = shortOptionLetters(word);
  return letters.length === word.length - 1 && SHORT_VALUE_OPTIONS.has(letters.at(-1));
}

/**
 * True when the shell command runs `git commit` in a way that executes the pre-commit hook
 * (`--no-verify` commits skip the hook and are not reported).
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isGitCommitCommand(command) {
  for (const words of shellCommandSegments(command)) {
    let index = 0;
    while (isShellAssignment(words[index])) index += 1;
    while (['sudo', 'command', 'exec', 'env'].includes(words[index]?.toLowerCase())) {
      index += 1;
      while (isShellAssignment(words[index])) index += 1;
    }
    if (!/^git(?:\.exe)?$/i.test(words[index] ?? '')) continue;

    index += 1;
    while (index < words.length) {
      const option = words[index];
      if (option === '--') {
        index += 1;
        break;
      }
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'].includes(option)) {
        index += 2;
        continue;
      }
      if (/^--(?:git-dir|work-tree|namespace|exec-path|config-env)=/.test(option)) {
        index += 1;
        continue;
      }
      if (/^--?[^\s]/.test(option)) {
        index += 1;
        continue;
      }
      break;
    }
    if (words[index]?.toLowerCase() === 'commit') {
      const commitArguments = words.slice(index + 1);
      for (let argumentIndex = 0; argumentIndex < commitArguments.length; argumentIndex += 1) {
        const argument = commitArguments[argumentIndex];
        if (argument === '--no-verify' || shortOptionLetters(argument).includes('n')) return false;
        if (argument === '--') break;
        if (COMMIT_VALUE_OPTIONS.has(argument) || shortOptionTakesNextWord(argument)) {
          argumentIndex += 1;
        }
      }
      return true;
    }
  }
  return false;
}
