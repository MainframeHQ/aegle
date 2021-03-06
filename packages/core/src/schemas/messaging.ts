import { MESSAGE_NAME, getID } from '../namespace'

import { FileData, fileProperty } from './fileSystem'
import { publicKeyProperty, swarmHashProperty } from './scalars'

export interface MessageAttachmentData {
  file: FileData
  name?: string
}

export const messageAttachmentProperty = {
  type: 'object',
  required: ['file'],
  properties: {
    file: fileProperty,
    name: { type: 'string', maxLength: 100 },
  },
}

export interface MessageData {
  body: string
  attachments?: Array<MessageAttachmentData>
  replyTo?: string
  thread?: string
  title?: string
}

export const messageSchema = {
  $async: true,
  $id: getID(MESSAGE_NAME),
  type: 'object',
  required: ['body'],
  properties: {
    body: { type: 'string' },
    attachments: {
      type: 'array',
      items: messageAttachmentProperty,
    },
    replyTo: swarmHashProperty,
    thread: swarmHashProperty,
    title: { type: 'string', maxLength: 100 },
  },
}

export type MailboxesRecord = Record<string, string>

export const mailboxesProperty = {
  type: 'object',
  patternProperties: {
    '^[0-9a-zA-Z-_. ]{1,50}$': publicKeyProperty,
  },
  additionalProperties: false,
}
