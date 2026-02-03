// 条文スタディ - 穴埋め（クローズ）機能
'use strict';

// 名前空間を確保
window.JyobunStudy = window.JyobunStudy || {};

// 正規表現エスケープ
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
window.JyobunStudy.escapeRegExp = escapeRegExp;

// クローズスパンを作成
function createClozeSpan(answer, hidden = false) {
    const span = document.createElement('span');
    span.className = 'cloze';
    span.dataset.answer = answer;
    if (hidden) {
        span.textContent = '＿'.repeat(Math.max(2, answer.length));
        span.classList.add('cloze-hidden');
    } else {
        span.textContent = answer;
    }
    return span;
}
window.JyobunStudy.createClozeSpan = createClozeSpan;

// テキストノードを正規表現で置換
function replaceTextNodeWithRegex(node, regex, replacer) {
    const text = node.nodeValue;
    let match;
    let lastIndex = 0;
    const frag = document.createDocumentFragment();
    regex.lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
        const before = text.slice(lastIndex, match.index);
        if (before) frag.appendChild(document.createTextNode(before));
        replacer(frag, match);
        lastIndex = match.index + match[0].length;
    }

    const after = text.slice(lastIndex);
    if (after) frag.appendChild(document.createTextNode(after));

    if (frag.childNodes.length > 0) {
        node.parentNode.replaceChild(frag, node);
        return true;
    }
    return false;
}
window.JyobunStudy.replaceTextNodeWithRegex = replaceTextNodeWithRegex;

// 穴埋め適用
function applyCloze(container, hideOnCreate = false) {
    if (container.dataset.clozeReady === 'true') return;

    const collectTextNodes = () => {
        const nodes = [];
        const localWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                if (node.parentElement && node.parentElement.closest('.cloze')) return NodeFilter.FILTER_REJECT;
                if (node.parentElement && node.parentElement.closest('.law-ref-internal')) return NodeFilter.FILTER_REJECT;
                if (node.parentElement && node.parentElement.closest('.internal-link')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        while (localWalker.nextNode()) {
            const n = localWalker.currentNode;
            if (n) nodes.push(n);
        }
        return nodes;
    };

    // CLOZE_PREDICATE_PATTERNS を参照
    const predicatePatterns = window.JyobunStudy.CLOZE_PREDICATE_PATTERNS || CLOZE_PREDICATE_PATTERNS;

    // 0) 主語（〜は）を穴埋め化（各文ごとに1回）
    collectTextNodes().forEach(node => {
        const text = node.nodeValue;
        if (!text || !text.trim()) return;

        const parts = (() => {
            const result = [];
            let buf = '';
            let parenDepth = 0;
            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                if (ch === '（') parenDepth++;
                if (ch === '）' && parenDepth > 0) parenDepth--;
                if ((ch === '。' || ch === '\n') && parenDepth === 0) {
                    result.push(buf);
                    result.push(ch);
                    buf = '';
                    continue;
                }
                buf += ch;
            }
            if (buf) result.push(buf);
            return result;
        })();
        let changed = false;
        const frag = document.createDocumentFragment();

        parts.forEach(part => {
            if (part === '。' || part === '\n') {
                frag.appendChild(document.createTextNode(part));
                return;
            }

            if (!part) return;

            let subjectIndex = -1;
            for (let i = 0; i < part.length; i++) {
                if (part[i] !== 'は') continue;
                const subjectFull = part.slice(0, i + 1);
                const subjectForCommaCheck = subjectFull.replace(/（[^）]*）/g, '');
                const commaCheck = subjectForCommaCheck.replace(/^.*?(ときは|場合には|にあつては|に対しては|については|とは)、/u, '');
                if (commaCheck.includes('、') || subjectFull.endsWith('には') ||
                    subjectFull.endsWith('ときは') || subjectFull.endsWith('とは') || subjectFull.endsWith('にあつては') ||
                    subjectFull.endsWith('場合には') || subjectFull.endsWith('に対しては') || subjectFull.endsWith('については') ||
                    /(とあるのは|ものは|ことは|ところは|ところによるは|又は|若しくは|または)$/.test(subjectFull)) {
                    continue;
                }
                subjectIndex = i;
                break;
            }
            if (subjectIndex === -1) {
                frag.appendChild(document.createTextNode(part));
                return;
            }

            const lastComma = part.lastIndexOf('、', subjectIndex);
            const before = lastComma >= 0 ? part.slice(0, lastComma + 1) : '';
            const after = part.slice(subjectIndex + 1);

            let subjectCore = part.slice(lastComma >= 0 ? lastComma + 1 : 0, subjectIndex);
            let subjectPrefix = '';
            const prefixMatch = subjectCore.match(/^(\s*(?:[一二三四五六七八九十]|[0-9]+|[０-９]+)[ 　]+)/);
            if (prefixMatch) {
                subjectPrefix = prefixMatch[1];
                subjectCore = subjectCore.slice(subjectPrefix.length);
            }
            subjectCore = subjectCore.replace(/^\s+/, '');

            if (before) frag.appendChild(document.createTextNode(before));
            if (subjectPrefix) frag.appendChild(document.createTextNode(subjectPrefix));
            frag.appendChild(createClozeSpan(subjectCore, hideOnCreate));
            frag.appendChild(document.createTextNode('は'));
            if (after) frag.appendChild(document.createTextNode(after));
            changed = true;
        });

        if (changed && node.parentNode) {
            node.parentNode.replaceChild(frag, node);
        }
    });

    // 1) 「」内の用語を穴埋め化
    collectTextNodes().forEach(node => {
        const quoteRegex = /「([^」]{2,30})」(?!\s*とあるのは)/g;
        if (!quoteRegex.test(node.nodeValue)) return;
        replaceTextNodeWithRegex(node, quoteRegex, (frag, match) => {
            frag.appendChild(document.createTextNode('「'));
            frag.appendChild(createClozeSpan(match[1], hideOnCreate));
            frag.appendChild(document.createTextNode('」'));
        });
    });

    // 1.5) （○○を除く。）パターンを穴埋め化
    collectTextNodes().forEach(node => {
        const exclusionRegex = /（([\s\S]{2,2500}?)(を除く。?)）/g;
        if (!exclusionRegex.test(node.nodeValue)) return;
        replaceTextNodeWithRegex(node, exclusionRegex, (frag, match) => {
            frag.appendChild(document.createTextNode('（'));
            frag.appendChild(createClozeSpan(match[1], hideOnCreate));
            frag.appendChild(document.createTextNode(match[2] + '）'));
        });
    });

    // 2) 末尾述語パターンを穴埋め化
    const predicateRegex = new RegExp(`(${predicatePatterns.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|')})(?=。|$)`, 'g');
    collectTextNodes().forEach(node => {
        if (!predicateRegex.test(node.nodeValue)) return;
        replaceTextNodeWithRegex(node, predicateRegex, (frag, match) => {
            frag.appendChild(createClozeSpan(match[1], hideOnCreate));
        });
    });

    container.dataset.clozeReady = 'true';
    container.dataset.clozeHidden = hideOnCreate ? 'true' : 'false';
}
window.JyobunStudy.applyCloze = applyCloze;

// 穴埋め表示/非表示を切り替え
function setClozeHidden(container, hidden) {
    const clozeSpans = container.querySelectorAll('.cloze');
    clozeSpans.forEach(span => {
        const answer = span.dataset.answer || span.textContent;
        if (hidden) {
            const placeholder = '＿'.repeat(Math.max(2, answer.length));
            span.textContent = placeholder;
            span.classList.add('cloze-hidden');
        } else {
            span.textContent = answer;
            span.classList.remove('cloze-hidden');
        }
    });
    container.dataset.clozeHidden = hidden ? 'true' : 'false';
}
window.JyobunStudy.setClozeHidden = setClozeHidden;
