export function parseArgs(argv, options = {}) {
  const booleanOptions = new Set(options.booleanOptions ?? []);
  const valueOptions = new Set(options.valueOptions ?? []);
  const repeatableValueOptions = new Set(options.repeatableValueOptions ?? []);
  const aliasMap = options.aliasMap ?? {};
  const parsed = { options: {}, positionals: [] };

  function setValueOption(name, value) {
    if (Object.hasOwn(parsed.options, name)) {
      if (!repeatableValueOptions.has(name)) {
        throw new Error(`Duplicate --${name}: this option can only be provided once`);
      }
      const current = parsed.options[name];
      parsed.options[name] = Array.isArray(current) ? [...current, value] : [current, value];
    } else {
      parsed.options[name] = value;
    }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      parsed.positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("-")) {
      parsed.positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawName, inlineValue] = token.slice(2).split("=", 2);
      const name = aliasMap[rawName] ?? rawName;
      if (booleanOptions.has(name)) {
        parsed.options[name] = inlineValue == null ? true : inlineValue !== "false";
        continue;
      }
      if (valueOptions.has(name)) {
        if (inlineValue != null) {
          setValueOption(name, inlineValue);
          continue;
        }
        index += 1;
        setValueOption(name, argv[index]);
        continue;
      }
      parsed.positionals.push(token);
      continue;
    }

    const short = token.slice(1);
    const name = aliasMap[short] ?? short;
    if (booleanOptions.has(name)) {
      parsed.options[name] = true;
      continue;
    }
    if (valueOptions.has(name)) {
      index += 1;
      setValueOption(name, argv[index]);
      continue;
    }
    parsed.positionals.push(token);
  }

  return parsed;
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`|([^\s]+)/g;
  for (const match of raw.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    tokens.push(value.replace(/\\(["'`\\])/g, "$1"));
  }
  return tokens;
}
