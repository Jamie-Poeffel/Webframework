import express from "express";
import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";

const app = express();

function normalizeEventHandlers(html) {
    return html.replace(
        /(\w+)=\{call\s*\(\s*\(\s*\)\s*=>\s*([\s\S]*?)\s*\)\s*\}/g,
        (_, attr, body) => {
            // Swap inner double quotes to single so they don't break the attribute
            const cleaned = body.trim().replace(/"/g, "'");
            return `${attr}="${cleaned}"`;
        }
    );
}

function normalizeAttributes(html) {
    return html.replace(/(\w+)="([^"]*)"/g, (match, attr, value) => {
        // If value contains double quotes, swap inner ones to single
        const cleaned = value.replace(/"/g, "'");
        return `${attr}="${cleaned}"`;
    });
}

// Walk the string tracking braces BUT skip over quoted attribute values
function convertJsx(rawHtml) {
    const html = normalizeEventHandlers(normalizeAttributes(rawHtml)); ;
    let result = "";
    let i = 0;

    while (i < html.length) {
        // Skip over quoted strings (attribute values)
        if (html[i] === '"' || html[i] === "'") {
            const quote = html[i];
            result += html[i++];
            while (i < html.length && html[i] !== quote) {
                result += html[i++];
            }
            if (i < html.length) result += html[i++]; // closing quote
            continue;
        }

        if (html[i] === "{") {
            // Find matching } counting depth, skipping quoted strings
            let depth = 1;
            let j = i + 1;
            while (j < html.length && depth > 0) {
                if (html[j] === '"' || html[j] === "'") {
                    const q = html[j++];
                    while (j < html.length && html[j] !== q) j++;
                    if (j < html.length) j++;
                    continue;
                }
                if (html[j] === "{") depth++;
                if (html[j] === "}") depth--;
                j++;
            }

            const expr = html.slice(i + 1, j - 1);
            result += "${" + processExpr(expr) + "}";
            i = j;
        } else {
            result += html[i];
            i++;
        }
    }

    return result;
}

function processExpr(expr) {
    const trimmed = expr.trim();

    const forMatch = trimmed.match(/^for\s*\(([\s\S]+?)\)\s*\{([\s\S]*)\}$/);
    if (forMatch) {
        const declaration = forMatch[1];
        const inner = forMatch[2].trim();

        const convertedInner = `\`${convertJsx(inner)}\``;

        return `((() => {
            const __out = [];
            for (${declaration}) {
                __out.push(${convertedInner});
            }
            return __out.join('');
        })())`;
    }

    const converted = expr.replace(
        /(<[a-zA-Z][^>]*>[\s\S]*?<\/[a-zA-Z]+>|<[a-zA-Z][^/>]*\/>)/g,
        (jsxTag) => "`" + convertJsx(jsxTag) + "`"
    );

    if (/\.map\s*\(/.test(converted) && !converted.includes(".join(")) {
        return converted + ".join('')";
    }

    return converted;
}

function extractFunction(content, startIndex) {
    let depth = 1;
    let i = startIndex;
    while (i < content.length && depth > 0) {
        if (content[i] === "{") depth++;
        if (content[i] === "}") depth--;
        i++;
    }
    return content.slice(startIndex, i - 1);
}

function extractCssImports(content) {
    const imports = [];
    const importRegex = /import\s+['"](.+\.css)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
        imports.push(match[1]); 
    }
    return imports;
}

function extractAll(content) {
    const mainMatch = content.match(/@main\s+(?:async\s+)?function\s+(\w+)\s*\(\)\s*\{/);
    if (!mainMatch) throw new Error("No @main function found");

    const mainName = mainMatch[1];
    const mainStart = mainMatch.index + mainMatch[0].length;
    const mainBody = extractFunction(content, mainStart);

    const helperRegex = /function\s+(\w+)\s*\((.*?)\)\s*\{/g;
    const helpers = [];
    const helperSources = []; 
    let match;

    while ((match = helperRegex.exec(content)) !== null) {
        if (match[1] === mainName) continue;
        const start = match.index + match[0].length;
        const body = extractFunction(content, start);
        helpers.push(`function ${match[1]}(${match[2]}) { ${body} }`);
        helperSources.push(`function ${match[1]}(${match[2]}) { ${body} }`); 
    }

    return { mainName, mainBody, helpers, helperSources };
}

function sanitizeBody(body) {
    return body.replace(
        /return\s*\(\s*(<[\s\S]*)\s*\);|return\s*(<[\s\S]*)/,
        (_, wrapped, bare) => {
            const html = (wrapped || bare).trim();
            return `return \`${convertJsx(html)}\``;
        }
    );
}

export async function runPage(filePath, dom) {
    const content = fs.readFileSync(filePath, "utf-8");

    const cssImports = extractCssImports(content);
    cssImports.forEach((cssFile) => {
        const link = dom.window.document.createElement("link");
        link.rel = "stylesheet";
        link.href = path.basename(cssFile);
        dom.window.document.head.appendChild(link);
    });

    const { mainName, mainBody, helpers, helperSources } = extractAll(content);
    const sanitized = sanitizeBody(mainBody);

    const code = `
        ${helpers.join("\n")}
        return (async function ${mainName}() {
            ${sanitized}
        })();
    `;

    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

    console.log("=== GENERATED CODE ===");
    console.log(code);
    console.log("======================");

    const fn = new AsyncFunction(code);

    return { html: await fn(), dom, helperSources };
}


app.use(express.static(path.resolve("./src")));

app.get("/", async (_req, res) => {
    const rawHtml = fs.readFileSync(path.resolve("index.html"), "utf-8");
    const dom = new JSDOM(rawHtml);

    const { html, dom: updatedDom, helperSources } = await runPage(path.resolve("./src/index.tvx"), dom);

    updatedDom.window.document.body.innerHTML = html;

    if (helperSources.length > 0) {
        const script = updatedDom.window.document.createElement("script");
        script.textContent = helperSources.join("\n");
        updatedDom.window.document.body.appendChild(script);
    }

    res.send(updatedDom.serialize());
});


app.listen(5500, () => {
    console.log("app is running on http://localhost:5500");
});