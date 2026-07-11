export function parseArgs(argv, options = {}) {
  const booleanOptions = new Set(options.booleanOptions ?? []);
  const valueOptions = new Set(options.valueOptions ?? []);
  const repeatableValueOptions = new Set(options.repeatableValueOptions ?? []);
  const aliasMap = options.aliasMap ?? {};
  const parsed = { options: {}, positionals: [], optionTerminatorIndex: null };

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

  function requireSeparateValue(name, index) {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) {
      throw new Error(
        `--${name} requires a value; use --${name}=<value> for values beginning with '-'`
      );
    }
    return value;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      parsed.optionTerminatorIndex = parsed.positionals.length;
      parsed.positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("-")) {
      parsed.positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const optionBody = token.slice(2);
      const equalsIndex = optionBody.indexOf("=");
      const rawName = equalsIndex === -1 ? optionBody : optionBody.slice(0, equalsIndex);
      const inlineValue = equalsIndex === -1 ? undefined : optionBody.slice(equalsIndex + 1);
      const name = aliasMap[rawName] ?? rawName;
      if (booleanOptions.has(name)) {
        if (inlineValue == null) {
          parsed.options[name] = true;
        } else if (inlineValue === "true") {
          parsed.options[name] = true;
        } else if (inlineValue === "false") {
          parsed.options[name] = false;
        } else {
          throw new Error(`Invalid --${name} boolean value: expected true or false`);
        }
        continue;
      }
      if (valueOptions.has(name)) {
        if (inlineValue != null) {
          setValueOption(name, inlineValue);
          continue;
        }
        const value = requireSeparateValue(name, index);
        index += 1;
        setValueOption(name, value);
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
      const value = requireSeparateValue(name, index);
      index += 1;
      setValueOption(name, value);
      continue;
    }
    parsed.positionals.push(token);
  }

  return parsed;
}
