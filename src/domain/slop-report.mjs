/**
 * Domain entity rendering the slop audit report in the skill://slop Part V
 * format. Single source for the VERDICT: contract the slop orchestrator
 * synthesizes and the /slop dispatcher reproduces verbatim.
 *
 * Rendering mirrors the retired dynamic-workflows slop report byte-for-byte:
 * first line `VERDICT: <verdict> — <reason>`, then the P1/P2/P3 sections with
 * counts, `Отсутствуют.` for empty sections, and a closing rejected-count line.
 */
export class SlopReport {
  static VERDICTS = new Set(['BLOCKED', 'CLEAN', 'ACCEPTABLE_WITH_NOTES', 'ERROR']);

  #verified;
  #rejectedCount;
  #verdict;
  #verdictReason;

  /**
   * @param {{verified?: Array, rejectedCount?: number, verdict?: string, verdictReason?: string}} result
   *   The slop-verifier output shape.
   */
  constructor({ verified = [], rejectedCount = 0, verdict = '', verdictReason = '' } = {}) {
    if (!Array.isArray(verified)) {
      throw new TypeError('SlopReport verified must be an array');
    }
    this.#verified = verified;
    this.#rejectedCount = Number.isFinite(rejectedCount) ? rejectedCount : 0;
    this.#verdict = typeof verdict === 'string' ? verdict : '';
    this.#verdictReason = typeof verdictReason === 'string' ? verdictReason : '';
  }

  /**
   * Builds a fail-closed ERROR report for a failed mandatory stage.
   * Never emits CLEAN for a failed stage.
   *
   * @param {string} reason
   * @returns {SlopReport}
   */
  static failure(reason) {
    return new SlopReport({ verdict: 'ERROR', verdictReason: String(reason ?? 'unknown failure') });
  }

  #resolvedVerdict() {
    // Verified findings veto a contradictory declared verdict: a P1 always
    // forces BLOCKED, and a declared CLEAN over non-empty findings is upgraded
    // to ACCEPTABLE_WITH_NOTES. Fail-closed direction only.
    if (this.#verified.some((item) => item?.category === 'P1')) {
      return 'BLOCKED';
    }
    if (this.#verified.length > 0) {
      return this.#verdict === 'BLOCKED' ? 'BLOCKED' : 'ACCEPTABLE_WITH_NOTES';
    }
    return SlopReport.VERDICTS.has(this.#verdict) ? this.#verdict : 'CLEAN';
  }

  #resolvedReason(verdict) {
    if (this.#verdictReason) {
      return SlopReport.#line(this.#verdictReason);
    }
    if (verdict === 'BLOCKED') {
      return 'Found P1 blockers';
    }
    if (verdict === 'ACCEPTABLE_WITH_NOTES') {
      return 'Only P2/P3 findings remain';
    }
    return 'No critical slop detected';
  }

  /**
   * Flattens untrusted LLM-supplied text to a single line so it cannot forge
   * standalone VERDICT: contract lines inside the rendered report.
   */
  static #line(value) {
    return String(value ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  }

  static #location(item) {
    const file = SlopReport.#line(item?.file);
    const line = SlopReport.#line(item?.line);
    return `[${file}${line ? `:${line}` : ''}]`;
  }

  /**
   * Renders the complete report in the skill://slop Part V format.
   *
   * @returns {string}
   */
  toString() {
    const verdict = this.#resolvedVerdict();
    const reason = this.#resolvedReason(verdict);
    let report = `VERDICT: ${verdict} — ${reason}\n\n`;

    const p1 = this.#verified.filter((item) => item?.category === 'P1');
    report += `### 🔴 P1: Блокеры (${p1.length})\n`;
    if (p1.length === 0) {
      report += 'Отсутствуют.\n\n';
    } else {
      for (const item of p1) {
        report += `- **${SlopReport.#location(item)}** ${SlopReport.#line(item.title)}\n`;
        report += `  - **Наблюдение:** ${SlopReport.#line(item.observation)}\n`;
        report += `  - **Механизм поломки:** ${SlopReport.#line(item.failureMechanism)}\n\n`;
      }
    }

    const p2 = this.#verified.filter((item) => item?.category === 'P2');
    report += `### 🟡 P2: Паразитная архитектура и нейрослоп (${p2.length})\n`;
    if (p2.length === 0) {
      report += 'Отсутствуют.\n\n';
    } else {
      for (const item of p2) {
        report += `- **${SlopReport.#location(item)}** ${SlopReport.#line(item.title)}\n`;
        report += `  - **Наблюдение:** ${SlopReport.#line(item.observation)}\n`;
        report += `  - **Нативная альтернатива:** ${SlopReport.#line(item.nativeAlternative) || 'Существующий доменный сервис / фреймворк'}\n\n`;
      }
    }

    const p3 = this.#verified.filter((item) => item?.category === 'P3');
    report += `### 🟢 P3: Дрифт документации и мелкие замечания (${p3.length})\n`;
    if (p3.length === 0) {
      report += 'Отсутствуют.\n\n';
    } else {
      for (const item of p3) {
        report += `- **${SlopReport.#location(item)}** ${SlopReport.#line(item.title)}: ${SlopReport.#line(item.observation)}\n`;
      }
    }
    report += `\n*(Отсеяно ревьюерских мнений и ложных срабатываний: ${this.#rejectedCount})*`;
    return report;
  }

  get verified() {
    return [...this.#verified];
  }

  get rejectedCount() {
    return this.#rejectedCount;
  }

  get verdict() {
    return this.#resolvedVerdict();
  }
}
