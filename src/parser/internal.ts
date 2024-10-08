import {
  DividerBlock,
  HeaderBlock,
  ImageBlock,
  KnownBlock,
  SectionBlock,
} from '@slack/types';
import {ListOptions, ParsingOptions} from '../types';
import {section, divider, header, image} from '../slack';
import {marked} from 'marked';
import {XMLParser} from 'fast-xml-parser';
import axios from 'axios';
import { URL } from 'url';

type PhrasingToken =
  | marked.Tokens.Link
  | marked.Tokens.Em
  | marked.Tokens.Strong
  | marked.Tokens.Del
  | marked.Tokens.Br
  | marked.Tokens.Image
  | marked.Tokens.Codespan
  | marked.Tokens.Text
  | marked.Tokens.HTML;

function parsePlainText(element: PhrasingToken): string[] {
  switch (element.type) {
    case 'link':
    case 'em':
    case 'strong':
    case 'del':
      return element.tokens.flatMap(child =>
        parsePlainText(child as PhrasingToken)
      );

    case 'br':
      return [];

    case 'image':
      return [element.title ?? element.href];

    case 'codespan':
    case 'text':
    case 'html':
      return [element.raw];
  }
}

function isSectionBlock(block: KnownBlock): block is SectionBlock {
  return block.type === 'section';
}

function parseMrkdwn(
  element: Exclude<PhrasingToken, marked.Tokens.Image>
): string {
  switch (element.type) {
    case 'link': {
      return `<${element.href}|${element.tokens
        .flatMap(child => parseMrkdwn(child as typeof element))
        .join('')}> `;
    }

    case 'em': {
      return `_${element.tokens
        .flatMap(child => parseMrkdwn(child as typeof element))
        .join('')}_`;
    }

    case 'codespan':
      return `\`${element.text}\``;

    case 'strong': {
      return `*${element.tokens
        .flatMap(child => parseMrkdwn(child as typeof element))
        .join('')}*`;
    }

    case 'text':
      return element.text;

    case 'del': {
      return `~${element.tokens
        .flatMap(child => parseMrkdwn(child as typeof element))
        .join('')}~`;
    }

    default:
      return '';
  }
}

function addMrkdwn(
  content: string,
  accumulator: (SectionBlock | ImageBlock)[]
) {
  const last = accumulator[accumulator.length - 1];

  if (last && isSectionBlock(last) && last.text) {
    last.text.text += content;
  } else {
    accumulator.push(section(content));
  }
}

function parsePhrasingContentToStrings(
  element: PhrasingToken,
  accumulator: string[]
) {
  if (element.type === 'image') {
    accumulator.push(element.href ?? element.title ?? element.text ?? 'image');
  } else {
    const text = parseMrkdwn(element);
    accumulator.push(text);
  }
}

function parsePhrasingContent(
  element: PhrasingToken,
  accumulator: (SectionBlock | ImageBlock)[]
) {
  if (element.type === 'image') {
    const imageBlock: ImageBlock = image(
      element.href,
      element.text || element.title || element.href,
      element.title
    );
    accumulator.push(imageBlock);
  } else {
    const text = parseMrkdwn(element);
    addMrkdwn(text, accumulator);
  }
}

function parseParagraph(element: marked.Tokens.Paragraph): KnownBlock[] {
  return element.tokens.reduce((accumulator, child) => {
    parsePhrasingContent(child as PhrasingToken, accumulator);
    return accumulator;
  }, [] as (SectionBlock | ImageBlock)[]);
}

function parseHeading(element: marked.Tokens.Heading): HeaderBlock {
  return header(
    element.tokens
      .flatMap(child => parsePlainText(child as PhrasingToken))
      .join('')
  );
}

function parseCode(element: marked.Tokens.Code): SectionBlock {
  return section(`\`\`\`\n${element.text}\n\`\`\``);
}

function parseList(
  element: marked.Tokens.List,
  options: ListOptions = {}
): SectionBlock {
  let index = 0;
  const contents = element.items.map(item => {
    const paragraph = item.tokens[0] as marked.Tokens.Text;
    if (!paragraph || paragraph.type !== 'text' || !paragraph.tokens?.length) {
      return paragraph?.text || '';
    }

    const text = paragraph.tokens
      .filter(
        (child): child is Exclude<PhrasingToken, marked.Tokens.Image> =>
          child.type !== 'image'
      )
      .flatMap(parseMrkdwn)
      .join('');

    if (element.ordered) {
      index += 1;
      return `${index}. ${text}`;
    } else if (item.checked !== null && item.checked !== undefined) {
      return `${options.checkboxPrefix?.(item.checked) ?? '• '}${text}`;
    } else {
      return `• ${text}`;
    }
  });

  return section(contents.join('\n'));
}

function combineBetweenPipes(texts: String[]): string {
  return `| ${texts.join(' | ')} |`;
}

function parseTableRows(rows: marked.Tokens.TableCell[][]): string[] {
  const parsedRows: string[] = [];
  rows.forEach((row, index) => {
    const parsedCells = parseTableRow(row);
    if (index === 1) {
      const headerRowArray = new Array(parsedCells.length).fill('---');
      const headerRow = combineBetweenPipes(headerRowArray);
      parsedRows.push(headerRow);
    }
    parsedRows.push(combineBetweenPipes(parsedCells));
  });
  return parsedRows;
}

function parseTableRow(row: marked.Tokens.TableCell[]): String[] {
  const parsedCells: String[] = [];
  row.forEach(cell => {
    parsedCells.push(parseTableCell(cell));
  });
  return parsedCells;
}

function parseTableCell(cell: marked.Tokens.TableCell): String {
  const texts = cell.tokens.reduce((accumulator, child) => {
    parsePhrasingContentToStrings(child as PhrasingToken, accumulator);
    return accumulator;
  }, [] as string[]);
  return texts.join(' ');
}

function parseTable(element: marked.Tokens.Table): SectionBlock {
  const parsedRows = parseTableRows([element.header, ...element.rows]);

  return section(`\`\`\`\n${parsedRows.join('\n')}\n\`\`\``);
}

function parseBlockquote(element: marked.Tokens.Blockquote): KnownBlock[] {
  return element.tokens
    .filter(
      (child): child is marked.Tokens.Paragraph => child.type === 'paragraph'
    )
    .flatMap(p =>
      parseParagraph(p).map(block => {
        if (isSectionBlock(block) && block.text?.text?.includes('\n'))
          block.text.text = '> ' + block.text.text.replace(/\n/g, '\n> ');
        return block;
      })
    );
}

function parseThematicBreak(): DividerBlock {
  return divider();
}

async function parseHTML(
  element: marked.Tokens.HTML | marked.Tokens.Tag
): Promise<KnownBlock[]> {
  try {
    const parser = new XMLParser({ ignoreAttributes: false });
    const res = parser.parse(element.raw);

    if (res.img) {
      const tags = res.img instanceof Array ? res.img : [res.img];

      const imageBlocks: KnownBlock[] = [];

      for (const img of tags) {
        const url: string = img['@_src'];

        if (!url || !isValidHttpUrl(url) || isLocalOrEmbeddedPath(url)) {
          continue;
        }

        try {
          const response = await axios.head(url);
          if (response.status >= 400) {
            continue;
          }
        } catch (error) {
          continue;
        }

        const imgBlock = image(url, img['@_alt'] || url);
        if (imgBlock) {
          imageBlocks.push(imgBlock);
        }
      }

      return imageBlocks;
    } else {
      return [];
    }
  } catch (error) {
    return [];
  }
}

export async function parseBlocks(
  tokens: marked.Token[],
  options: ParsingOptions = {}
): Promise<KnownBlock[]> {
  const blocks: KnownBlock[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        blocks.push(header(token.text));
        break;

      case 'paragraph':
        if (token.tokens.some(subToken => subToken.type === 'image')) {
          const validImages = token.tokens.filter(subToken => {
            if (subToken.type === 'image') {
              const url = subToken.href;

              if (!url || isLocalOrEmbeddedPath(url) || !isValidHttpUrl(url)) {
                return false;
              }
            }
            return true;
          });

          if (validImages.length === 0) {
            continue;
          }
        }
        blocks.push(section(token.text));
        break;

      case 'image':
        const url = token.href;

        if (!url || isLocalOrEmbeddedPath(url) || !isValidHttpUrl(url)) {
          continue;
        }

        blocks.push(image(url, token.text || url));
        break;

      case 'code':
        blocks.push(section(`\`\`\`${token.lang || ''}\n${token.text}\n\`\`\``));
        break;

      case 'blockquote':
        blocks.push(section(`>${token.text}`));
        break;

      case 'list':
        blocks.push(parseList(token, options.lists));
        break;

      case 'hr':
        blocks.push(divider());
        break;

      case 'html':
        const htmlBlocks = await parseHTML(token);
        blocks.push(...htmlBlocks);
        break;

      default:
        break;
    }
  }

  return blocks;
}

function isLocalOrEmbeddedPath(urlString: string): boolean {
  return urlString.startsWith('C:') || urlString.startsWith('D:') || 
         urlString.startsWith('file:') || urlString.startsWith('embedded:');
}

function isValidHttpUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);

    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
}