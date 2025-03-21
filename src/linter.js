"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lintHtml = lintHtml;
// src/linter.ts
var htmlparser2_1 = require("htmlparser2");
function lintHtml(html) {
    var results = [];
    var tagStack = [];
    console.log(results);
    var currentLine = 0;
    var currentColumn = 0;
    var parser = new htmlparser2_1.Parser({
        ontext: function (text) {
            // Track new lines in text nodes
            var lines = text.split("\n");
            if (lines.length > 1) {
                currentLine += lines.length - 1;
                currentColumn = lines[lines.length - 1].length;
            }
            else {
                currentColumn += text.length;
            }
        },
        onopentag: function (name) {
            var currentTag = {
                tag: name,
                line: currentLine,
                column: currentColumn,
            };
            tagStack.push(currentTag);
            // Rule: <li> must be inside <ul> or <ol>
            if (name === 'li') {
                var parent_1 = tagStack[tagStack.length - 2];
                if (!parent_1 || (parent_1.tag !== 'ul' && parent_1.tag !== 'ol')) {
                    results.push({
                        line: currentTag.line,
                        column: currentTag.column,
                        message: '<li> must be inside a <ul> or <ol>'
                    });
                }
            }
        },
        onclosetag: function () {
            tagStack.pop();
        }
    }, { decodeEntities: true, xmlMode: false, recognizeSelfClosing: true });
    parser.write(html);
    parser.end();
    return results;
}
