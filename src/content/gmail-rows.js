/**
 * JevGuard — Gmail DOM adapter.
 *
 * Classic content script (NOT a module): it publishes itself on the single shared
 * global `window.JevGuard`. This is the only file that knows anything about Gmail's
 * markup; inject.js talks to it through `window.JevGuard.rows` and never queries
 * a Gmail class itself.
 *
 * Gmail's class names are obfuscated and rotate, so every selector here is an
 * ordered list: the historically stable name first, then looser structural
 * fallbacks. Nothing throws: a lookup that fails returns "" / null / [].
 *
 * Every read of the page goes through query() / queryAll() / cells() / text(),
 * which all skip JevGuard's own nodes (`.jg-badge`, `.jg-cell`). The overlay badge
 * lives INSIDE the row's subject cell and carries its own text and `title`, so
 * reading it back would poison the subject, the date and the content hash used as
 * row id — which in turn makes every paint look like a recycled row.
 */
(function () {
  "use strict";

  const NS = (window.JevGuard = window.JevGuard || {});
  if (NS.rows) return; // already injected in this frame

  const warned = new Set();
  function warnOnce(key, message, detail) {
    if (warned.has(key)) return;
    warned.add(key);
    if (detail === undefined) console.warn("[JevGuard]", message);
    else console.warn("[JevGuard]", message, detail);
  }

  /** Row containers, from the most specific Gmail markup to a generic ARIA grid. */
  const ROW_SELECTORS = [
    'div[role="main"] tr.zA',
    'div[role="main"] table.F tr[role="row"]',
    'div[role="main"] [role="row"]'
  ];

  const SUBJECT_SELECTORS = [".bog", ".y6 span:first-child"];
  const SNIPPET_SELECTORS = [".y2", ".y6 > span:not(:first-child)", ".xT span:last-child"];
  const ATTACHMENT_SELECTORS = [".brd", '[data-tooltip*="llegat"]', 'img[alt*="ttach"]'];
  const DATE_SELECTORS = ["td.xW", ".xW", "td.xY span[title]"];
  const SUBJECT_CELL_SELECTOR = "td.xY.a4W";
  /** The grid the purely structural row heuristic is allowed to run inside. */
  const LIST_GRID_SELECTOR = '[role="grid"], table.F';

  /** Our own nodes: never part of Gmail's content. */
  const OWN_SELECTOR = ".jg-badge, .jg-cell";

  /** Leading separator Gmail puts between subject and snippet (nbsp included). */
  const SNIPPET_PREFIX = /^[\s ]*[-–—][\s ]*/;

  /**
   * Views where `span[email]` is the RECIPIENT, not the sender: scoring them would
   * judge the user's own outgoing mail as if it came from the recipient's domain.
   */
  const RECIPIENT_VIEWS = /^#(sent|drafts|scheduled|outbox|templates)\b/;

  /** "" in a normal view, otherwise the name of the recipient-side view. */
  function recipientView() {
    const hash = String((window.location && window.location.hash) || "").toLowerCase();
    const match = RECIPIENT_VIEWS.exec(hash);
    return match ? match[1] : "";
  }

  /** The node itself is one of ours. */
  function isOwnNode(node) {
    if (!node || node.nodeType !== 1 || !node.classList) return false;
    return node.classList.contains("jg-badge") || node.classList.contains("jg-cell");
  }

  /** The node is one of ours, or lives inside one. */
  function inOwnNode(node) {
    if (isOwnNode(node)) return true;
    if (!node || node.nodeType !== 1 || typeof node.closest !== "function") return false;
    return Boolean(node.closest(OWN_SELECTOR));
  }

  /** textContent minus every JevGuard subtree; falls back to a plain read. */
  function rawText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1 || isOwnNode(node)) return "";
    if (typeof node.querySelector !== "function" || !node.querySelector(OWN_SELECTOR)) {
      return node.textContent || "";
    }
    let value = "";
    for (let child = node.firstChild; child; child = child.nextSibling) value += rawText(child);
    return value;
  }

  function text(node) {
    return rawText(node).replace(/\s+/g, " ").trim();
  }

  function attr(node, name) {
    if (!node || typeof node.getAttribute !== "function") return "";
    const value = node.getAttribute(name);
    return typeof value === "string" ? value.trim() : "";
  }

  /** First match that is not one of our own nodes (the badge carries a `title`). */
  function query(root, selector) {
    if (!root || typeof root.querySelectorAll !== "function") return null;
    try {
      const found = root.querySelectorAll(selector);
      for (let i = 0; i < found.length; i += 1) {
        if (!inOwnNode(found[i])) return found[i];
      }
      return null;
    } catch (error) {
      warnOnce("selector:" + selector, "selettore non valido: " + selector, error);
      return null;
    }
  }

  function queryAll(root, selector) {
    if (!root || typeof root.querySelectorAll !== "function") return [];
    try {
      return Array.prototype.slice.call(root.querySelectorAll(selector)).filter((node) => !inOwnNode(node));
    } catch (error) {
      warnOnce("selectorAll:" + selector, "selettore non valido: " + selector, error);
      return [];
    }
  }

  /** The row's own cells: real `td`s when present, otherwise direct children. */
  function cells(row) {
    const tds = queryAll(row, ":scope > td");
    if (tds.length) return tds;
    if (!row || !row.children) return [];
    return Array.prototype.slice.call(row.children).filter((child) => !isOwnNode(child));
  }

  function isHeaderRow(row) {
    if (!row || row.nodeType !== 1) return true;
    if (typeof row.closest === "function" && row.closest("thead")) return true;
    if (query(row, ":scope > th")) return true;
    if (query(row, '[role="columnheader"]')) return true;
    return false;
  }

  /** A cell that looks like it carries a subject / snippet. */
  function hasSubjectLook(row) {
    if (query(row, ".bog") || query(row, ".y6") || query(row, SUBJECT_CELL_SELECTOR)) return true;
    // Generic structural fallback: enough cells and enough text to be a message line.
    const list = cells(row);
    if (list.length < 3) return false;
    return text(row).length >= 10;
  }

  /**
   * A row of the message list. Anything that identifies a message (a sender chip, a
   * subject node, a thread id) is accepted anywhere; the purely structural heuristic
   * is confined to the list grid, otherwise the generic `[role="row"]` selector
   * matches table rows inside an opened HTML email, which Gmail renders inline.
   */
  function isMessageRow(row) {
    if (isHeaderRow(row)) return false;
    if (inOwnNode(row)) return false;
    if (
      query(row, "span[email]") ||
      query(row, ".bog") ||
      attr(row, "data-legacy-thread-id") ||
      query(row, "[data-legacy-thread-id]")
    ) {
      return true;
    }
    if (typeof row.closest !== "function" || !row.closest(LIST_GRID_SELECTOR)) return false;
    return hasSubjectLook(row);
  }

  /**
   * Message rows currently in the DOM. The first selector that yields at least one
   * usable row wins, so a Gmail redesign degrades instead of breaking.
   */
  function listRows() {
    const view = recipientView();
    if (view) {
      warnOnce(
        "recipient-view:" + view,
        'vista "' + view + '": le righe mostrano il destinatario e non il mittente, nessuna riga analizzata qui.'
      );
      return [];
    }
    for (let i = 0; i < ROW_SELECTORS.length; i += 1) {
      const found = queryAll(document, ROW_SELECTORS[i]);
      if (!found.length) continue;
      const rows = found.filter(isMessageRow);
      if (rows.length) {
        if (i > 0) warnOnce("row-fallback:" + i, "righe trovate con il selettore di riserva: " + ROW_SELECTORS[i]);
        return rows;
      }
    }
    return [];
  }

  /** djb2 — only used when Gmail gives us no stable id at all. */
  function djb2(value) {
    let hash = 5381;
    for (let i = 0; i < value.length; i += 1) {
      hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  }

  function dateText(row) {
    for (const selector of DATE_SELECTORS) {
      const node = query(row, selector);
      if (!node) continue;
      const title = attr(node, "title");
      const value = title || text(node);
      if (value) return value;
    }
    const list = cells(row);
    return list.length ? text(list[list.length - 1]) : "";
  }

  function dateCell(row) {
    for (const selector of DATE_SELECTORS) {
      const node = query(row, selector);
      if (!node) continue;
      const owner = cells(row).find((cell) => cell === node || cell.contains(node));
      if (owner) return owner;
    }
    const list = cells(row);
    return list.length ? list[list.length - 1] : null;
  }

  function subjectNode(row) {
    for (const selector of SUBJECT_SELECTORS) {
      const node = query(row, selector);
      if (node && text(node)) return node;
    }
    return null;
  }

  function snippetText(row) {
    for (const selector of SNIPPET_SELECTORS) {
      const node = query(row, selector);
      const value = text(node);
      if (value) return value.replace(SNIPPET_PREFIX, "").trim();
    }
    return "";
  }

  /** The cell that holds subject + snippet — where the overlay badge is anchored. */
  function subjectCell(row) {
    if (!row || row.nodeType !== 1) return null;
    const direct = query(row, SUBJECT_CELL_SELECTOR);
    if (direct) return direct;

    const node = subjectNode(row);
    if (node) {
      const owner = cells(row).find((cell) => cell === node || cell.contains(node));
      if (owner) return owner;
      const td = typeof node.closest === "function" ? node.closest("td") : null;
      if (td && !isOwnNode(td)) return td;
    }

    // Last resort: the rightmost cell with text that is NOT the date cell. Anchoring
    // on the date cell would push the date 62px left and hide the badge under
    // Gmail's hover toolbar; inject.js handles a null host (warns once, skips).
    const list = cells(row);
    const skipDate = dateCell(row);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i] !== skipDate && text(list[i])) return list[i];
    }
    return null;
  }

  function senderCell(row, sender) {
    if (sender) {
      const owner = cells(row).find((cell) => cell === sender || cell.contains(sender));
      if (owner) return owner;
    }
    return null;
  }

  /** Fallback subject: the first cell with text that is neither sender nor date. */
  function fallbackSubject(row, sender) {
    const skipSender = senderCell(row, sender);
    const skipDate = dateCell(row);
    const list = cells(row);
    for (const cell of list) {
      if (cell === skipSender || cell === skipDate) continue;
      const value = text(cell);
      if (value) return value;
    }
    return "";
  }

  /** Fallback sender name when the row carries no span[email] at all. */
  function fallbackSender(row) {
    const skipSubject = subjectCell(row);
    const skipDate = dateCell(row);
    const list = cells(row);
    for (const cell of list) {
      if (cell === skipSubject || cell === skipDate) continue;
      const value = text(cell);
      if (value) return value;
    }
    return "";
  }

  /**
   * A row id that identifies the MESSAGE, not the element. Gmail's own `id`
   * attribute is a Closure-generated handle (`:2oc`) that is reused for a different
   * message as soon as the list re-renders, and verdicts are cached by this id, so
   * it is never used: only the thread id, then a hash of the row's content.
   */
  function rowId(row, seed) {
    const own = row && row.dataset ? row.dataset.legacyThreadId : "";
    if (own) return own;
    const nested = query(row, "[data-legacy-thread-id]");
    const nestedId = nested && nested.dataset ? nested.dataset.legacyThreadId : "";
    if (nestedId) return nestedId;
    return "jg-" + djb2(seed);
  }

  /** Extract one RowData (CONTRACT.md §2). Never throws, never returns null fields. */
  function extractRow(row) {
    if (!row || row.nodeType !== 1) return null;

    const senders = queryAll(row, "span[email]");
    const sender = senders.length ? senders[0] : null;

    const senderAddress = sender ? attr(sender, "email") : "";
    let senderName = sender ? attr(sender, "name") : "";
    if (!senderName && sender) senderName = text(sender) || attr(sender, "title");
    if (!senderName) senderName = senderAddress || fallbackSender(row);

    const otherSendersCount = Math.max(0, senders.length - 1);

    const subjectFromNode = text(subjectNode(row));
    let subject = subjectFromNode || fallbackSubject(row, sender);
    let snippet = snippetText(row);
    // When the subject came from a whole cell it may still carry the snippet.
    if (snippet && subject !== snippet && subject.endsWith(snippet)) {
      subject = subject.slice(0, subject.length - snippet.length).replace(/[\s ]*[-–—][\s ]*$/, "").trim();
    }
    // A structural snippet fallback can land on the subject node itself.
    if (snippet && snippet === subject) snippet = "";

    const hasAttachment = ATTACHMENT_SELECTORS.some((selector) => Boolean(query(row, selector)));

    const id = rowId(row, senderName + "|" + senderAddress + "|" + subject + "|" + dateText(row));

    return {
      id: id,
      senderName: senderName,
      senderAddress: senderAddress,
      subject: subject,
      snippet: snippet,
      hasAttachment: hasAttachment,
      otherSendersCount: otherSendersCount
    };
  }

  NS.rows = {
    listRows: listRows,
    extractRow: extractRow,
    subjectCell: subjectCell
  };
})();
