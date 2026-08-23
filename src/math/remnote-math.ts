import type { RichTextInterface, RichTextLatexInterface, RNPlugin } from '@remnote/plugin-sdk';

export async function createNativeLatex(
  plugin: RNPlugin,
  latex: string,
  block = false,
): Promise<RichTextInterface> {
  return plugin.richText.latex(latex, block).value();
}

export function isNativeLatexElement(value: unknown): value is RichTextLatexInterface {
  return (
    typeof value === 'object' &&
    value !== null &&
    'i' in value &&
    value.i === 'x' &&
    'text' in value &&
    typeof value.text === 'string'
  );
}

function getElementLength(elem: RichTextInterface[number]): number {
  if (typeof elem === 'string') {
    return elem.length;
  }
  if (typeof elem === 'object' && elem !== null) {
    if (elem.i === 'm' && 'text' in elem && typeof elem.text === 'string') {
      return elem.text.length;
    }
    return 1;
  }
  return 0;
}

export function insertRichTextAtRange(
  original: RichTextInterface | undefined,
  inserted: RichTextInterface,
  range: { start: number; end: number },
): RichTextInterface {
  if (!original || original.length === 0) {
    return [...inserted];
  }

  const result: RichTextInterface = [];
  const { start, end } = range;
  let currentOffset = 0;
  let insertedDone = false;

  for (const elem of original) {
    const elemLen = getElementLength(elem);
    const elemStart = currentOffset;
    const elemEnd = currentOffset + elemLen;
    currentOffset = elemEnd;

    if (elemEnd <= start) {
      // Entirely before range
      result.push(elem);
    } else if (elemStart >= end) {
      // Entirely after range
      if (!insertedDone) {
        result.push(...inserted);
        insertedDone = true;
      }
      result.push(elem);
    } else {
      // Overlaps the half-open range [start, end)
      if (typeof elem === 'string') {
        const keepLeft = elem.slice(0, Math.max(0, start - elemStart));
        const keepRight = elem.slice(Math.max(0, end - elemStart));

        if (keepLeft.length > 0) {
          result.push(keepLeft);
        }

        if (!insertedDone) {
          result.push(...inserted);
          insertedDone = true;
        }

        if (keepRight.length > 0) {
          result.push(keepRight);
        }
      } else if (
        typeof elem === 'object' &&
        elem !== null &&
        elem.i === 'm' &&
        typeof elem.text === 'string'
      ) {
        const keepLeftText = elem.text.slice(0, Math.max(0, start - elemStart));
        const keepRightText = elem.text.slice(Math.max(0, end - elemStart));

        if (keepLeftText.length > 0) {
          result.push({ ...elem, text: keepLeftText });
        }

        if (!insertedDone) {
          result.push(...inserted);
          insertedDone = true;
        }

        if (keepRightText.length > 0) {
          result.push({ ...elem, text: keepRightText });
        }
      } else {
        if (!insertedDone) {
          result.push(...inserted);
          insertedDone = true;
        }
        if (elemStart >= end || elemEnd <= start) {
          result.push(elem);
        }
      }
    }
  }

  if (!insertedDone) {
    result.push(...inserted);
  }

  return result.filter((item) => {
    if (typeof item === 'string') return item.length > 0;
    if (
      typeof item === 'object' &&
      item !== null &&
      item.i === 'm' &&
      typeof item.text === 'string'
    ) {
      return item.text.length > 0;
    }
    return true;
  });
}

export type FoundMathElement = {
  element: RichTextLatexInterface;
  range: { start: number; end: number };
};

export function findMathElementAtRange(
  richText: RichTextInterface | undefined,
  selectionRange: { start: number; end: number },
): FoundMathElement | undefined {
  if (!richText || richText.length === 0) {
    return undefined;
  }

  const { start, end } = selectionRange;

  // Pass 1: Standard RichText offset (math element length = 1)
  let standardOffset = 0;
  for (const elem of richText) {
    const elemLen = getElementLength(elem);
    const elemStart = standardOffset;
    const elemEnd = standardOffset + elemLen;
    standardOffset = elemEnd;

    if (isNativeLatexElement(elem)) {
      const overlaps =
        start === end ? start >= elemStart && start <= elemEnd : start < elemEnd && end > elemStart;

      if (overlaps) {
        return {
          element: elem,
          range: { start: elemStart, end: elemEnd },
        };
      }
    }
  }

  // Pass 2: Expanded character offset (math element length = elem.text.length)
  // This occurs when the cursor is clicked inside RemNote's Slate LaTeX sub-editor.
  let expandedOffset = 0;
  standardOffset = 0;
  for (const elem of richText) {
    const stdLen = getElementLength(elem);
    const expLen = isNativeLatexElement(elem) ? Math.max(1, elem.text.length) : stdLen;

    const stdStart = standardOffset;
    const stdEnd = standardOffset + stdLen;
    standardOffset = stdEnd;

    const expStart = expandedOffset;
    const expEnd = expandedOffset + expLen;
    expandedOffset = expEnd;

    if (isNativeLatexElement(elem)) {
      const overlaps =
        start === end ? start >= expStart && start <= expEnd : start < expEnd && end > expStart;

      if (overlaps) {
        return {
          element: elem,
          range: { start: stdStart, end: stdEnd },
        };
      }
    }
  }

  // Pass 3: Single math element in the Rem fallback
  // If the Rem contains solely a math element (with optional whitespace) and the selection falls within its text
  const isOnlyMath = richText.every((item) => {
    if (typeof item === 'string') return item.trim().length === 0;
    return isNativeLatexElement(item);
  });

  const mathElements: { elem: RichTextLatexInterface; range: { start: number; end: number } }[] =
    [];
  standardOffset = 0;
  for (const elem of richText) {
    const stdLen = getElementLength(elem);
    const stdStart = standardOffset;
    const stdEnd = standardOffset + stdLen;
    standardOffset = stdEnd;

    if (isNativeLatexElement(elem)) {
      mathElements.push({ elem, range: { start: stdStart, end: stdEnd } });
    }
  }

  if (isOnlyMath && mathElements.length === 1) {
    const single = mathElements[0];
    let expandedStart = 0;
    for (const elem of richText) {
      if (elem === single.elem) break;
      expandedStart += isNativeLatexElement(elem)
        ? Math.max(1, elem.text.length)
        : getElementLength(elem);
    }
    const expandedEnd = expandedStart + Math.max(1, single.elem.text.length);
    const overlaps =
      start === end
        ? start >= expandedStart && start < expandedEnd
        : start < expandedEnd && end > expandedStart;

    if (overlaps) {
      return {
        element: single.elem,
        range: single.range,
      };
    }
  }

  return undefined;
}
