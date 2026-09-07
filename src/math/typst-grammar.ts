import Prism from 'prismjs';

export const typstGrammar: Prism.Grammar = {
  string: {
    pattern: /"(?:\\.|[^\\"])*"/,
    greedy: true,
  },
  comment: {
    pattern: /(^|[^\\])(?:\/\*[\s\S]*?\*\/|\/\/.*)/,
    lookbehind: true,
    greedy: true,
  },
  builtin: {
    pattern: /#(?:none|true|false|auto|nan|inf)\b/,
    alias: 'constant',
  },
  parameter: {
    pattern: /\b[a-zA-Z_][a-zA-Z0-9_-]*(?=\s*:)/,
    alias: 'attr-name',
  },
  function: {
    pattern:
      /\b(?:mat|vec|cases|sum|prod|integral|int|sqrt|root|lim|floor|ceil|round|norm|abs|binom|attach|scripts|limits|overbrace|underbrace|overline|underline|rect|box|frac|bold|upright|serif|italic|sans|cal|scr|frak|mono|bb|display|inline|script|sscript|hat|tilde|macron|acute|grave|breve|check|circle|ring|cancel|overbracket|underbracket|lr|mid|diaer|harpoon|hide|mod|dif|Dif)(?=[^a-zA-Z0-9]|$)/,
  },
  keyword: {
    pattern: /\b(?:let|set|show|if|else|for|while|return|include|import|as)(?=[^a-zA-Z0-9]|$)/,
  },
  symbol: {
    pattern:
      /\b(?:alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|Alpha|Beta|Gamma|Delta|Epsilon|Zeta|Eta|Theta|Iota|Kappa|Lambda|Mu|Nu|Xi|Omicron|Pi|Rho|Sigma|Tau|Upsilon|Phi|Chi|Psi|Omega|NN|ZZ|QQ|RR|CC|PP|EE|HH|aleph|beth|gimel|daleth|oo|dif|Dif|times|div|cdot|pm|mp|plus\.minus|minus\.plus|dots|approx|equiv|prec|succ|subset|supset|union|inter|forall|exists|not|and|or|top|bot|nabla|partial|degree|thin|med|thick|quad|wide|in|arrow|dot|dots|space|integral|chevron|angle|eq|compose|therefore|convolve|asymp|csch|sech|ctg|lcm|sinc|tg|lg|diaer|harpoon)(?:\.[a-zA-Z0-9_]+)*(?=[^a-zA-Z0-9]|$)/,
    alias: 'variable',
  },
  number: /\b\d+(?:\.\d+)?(?:pt|mm|cm|in|em|deg|rad|%)?\b/,
  operator:
    /==>|<==>|<->|-->|<--|<==|\|->|~>|<~|=>|->|<-|<=>|<=|>=|!=|:=|::=|=:|[-+*/=!<>&|^~:]+|[_^]/,
  punctuation: /\[\||\|\]|[{}[\]();,]/,
};

Prism.languages.typst = typstGrammar;

export function highlightTypst(code: string): string {
  return Prism.highlight(code, typstGrammar, 'typst');
}
