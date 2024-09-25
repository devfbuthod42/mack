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

function isValidHttpUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);

    // On ne valide que les protocoles HTTP et HTTPS
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false; // Si l'URL ne peut pas être parsée, elle est considérée comme invalide
  }
}

function isLocalOrEmbeddedPath(urlString: string): boolean {
  // Ignorer les chemins locaux (C:\, D:\, file://, embedded:...)
  return urlString.startsWith('C:') || urlString.startsWith('D:') || 
         urlString.startsWith('file:') || urlString.startsWith('embedded:');
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
        console.log("URL STRING : ", url);

        // Ignorer les chemins locaux ou intégrés explicitement
        if (!url || !isValidHttpUrl(url) || isLocalOrEmbeddedPath(url)) {
          continue; // Skip non-valid URLs (including local paths like C:\ or embedded:)
        }

        // Vérifier si l'image est accessible via une requête HEAD
        try {
          const response = await axios.head(url);
          if (response.status >= 400) {
            continue; // Ignorer si l'image n'est pas accessible
          }
        } catch (error) {
          continue; // Ignorer les erreurs réseau ou d'accès
        }

        // Si l'image est valide, l'ajouter aux blocs
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
    return []; // En cas d'erreur générale, renvoyer un tableau vide sans logging
  }
}

async function parseToken(
  token: marked.Token,
  options: ParsingOptions
): Promise<KnownBlock[]> {
  switch (token.type) {
    case 'heading':
      return [parseHeading(token)];

    case 'paragraph':
      return parseParagraph(token);

    case 'code':
      return [parseCode(token)];

    case 'blockquote':
      return parseBlockquote(token);

    case 'list':
      return [parseList(token, options.lists)];

    case 'table':
      return [parseTable(token)];

    case 'hr':
      return [parseThematicBreak()];

    case 'image':
      const url = token.href;

      // Vérification des URL locales ou intégrées avant de continuer
      if (!url || isLocalOrEmbeddedPath(url) || !isValidHttpUrl(url)) {
        return []; // Ignorer les images avec des chemins non HTTP/HTTPS
      }

      // Vérifier si l'image est accessible via une requête HEAD
      try {
        const response = await axios.head(url);
        if (response.status >= 400) {
          return []; // Ignorer si l'image n'est pas accessible
        }
      } catch (error) {
        return []; // Ignorer les erreurs réseau ou d'accès
      }

      // Si l'image est valide, retourner le bloc image
      return [image(url, token.text || url)];

    case 'html':
      return await parseHTML(token); // Attendre le résultat asynchrone de parseHTML

    default:
      return [];
  }
}

export async function parseBlocks(
  tokens: marked.TokensList,
  options: ParsingOptions = {}
): Promise<KnownBlock[]> {
  const blockPromises = tokens.map(token => parseToken(token, options));
  
  // Attendre que toutes les promesses soient résolues
  const blocks = await Promise.all(blockPromises);

  // Aplatir le tableau de résultats
  return blocks.flat();
}