/**
 * @license
 * Copyright (C) 2020 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import '@polymer/paper-toggle-button/paper-toggle-button';
import '../../shared/gr-button/gr-button';
import '../../shared/gr-icons/gr-icons';
import '../gr-message/gr-message';
import '../../../styles/gr-paper-styles';
import '../../../styles/shared-styles';
import {PolymerElement} from '@polymer/polymer/polymer-element';
import {htmlTemplate} from './gr-messages-list_html';
import {
  KeyboardShortcutMixin,
  Shortcut,
  ShortcutSection,
} from '../../../mixins/keyboard-shortcut-mixin/keyboard-shortcut-mixin';
import {parseDate} from '../../../utils/date-util';
import {MessageTag} from '../../../constants/constants';
import {appContext} from '../../../services/app-context';
import {customElement, property} from '@polymer/decorators';
import {
  ChangeId,
  ChangeMessageId,
  ChangeMessageInfo,
  ChangeViewChangeInfo,
  LabelNameToInfoMap,
  NumericChangeId,
  PatchSetNum,
  RepoName,
  ReviewerUpdateInfo,
  VotingRangeInfo,
} from '../../../types/common';
import {ChangeComments} from '../../diff/gr-comment-api/gr-comment-api';
import {CommentThread, isRobot} from '../../../utils/comment-util';
import {GrMessage, MessageAnchorTapDetail} from '../gr-message/gr-message';
import {PolymerDeepPropertyChange} from '@polymer/polymer/interfaces';
import {DomRepeat} from '@polymer/polymer/lib/elements/dom-repeat';
import {getVotingRange} from '../../../utils/label-util';
import {FormattedReviewerUpdateInfo} from '../../../types/types';

/**
 * The content of the enum is also used in the UI for the button text.
 */
enum ExpandAllState {
  EXPAND_ALL = 'Expand All',
  COLLAPSE_ALL = 'Collapse All',
}

interface TagsCountReportInfo {
  [tag: string]: number;
  all: number;
}

type CombinedMessage = Omit<
  FormattedReviewerUpdateInfo | ChangeMessageInfo,
  'tag'
> & {
  _revision_number?: PatchSetNum;
  _index?: number;
  expanded?: boolean;
  isImportant?: boolean;
  commentThreads?: CommentThread[];
  tag?: string;
};

function isChangeMessageInfo(x: CombinedMessage): x is ChangeMessageInfo {
  return (x as ChangeMessageInfo).id !== undefined;
}

function getMessageId(x: CombinedMessage): ChangeMessageId | undefined {
  return isChangeMessageInfo(x) ? x.id : undefined;
}

/**
 * Computes message author's comments for this change message. The backend
 * sets comment.change_message_id for matching, so this computation is fairly
 * straightforward.
 */
function computeThreads(
  message: CombinedMessage,
  allThreadsForChange: CommentThread[]
): CommentThread[] {
  if (message._index === undefined) {
    return [];
  }
  const messageId = getMessageId(message);
  return allThreadsForChange.filter(thread =>
    thread.comments.some(comment => {
      const matchesMessage = comment.change_message_id === messageId;
      if (!matchesMessage) return false;
      comment.collapsed = !matchesMessage;
      return matchesMessage;
    })
  );
}

/**
 * If messages have the same tag, then that influences grouping and whether
 * a message is initially hidden or not, see isImportant(). So we are applying
 * some "magic" rules here in order to hide exactly the right messages.
 *
 * 1. If a message does not have a tag, but is associated with robot comments,
 * then it gets a tag.
 *
 * 2. Use the same tag for some of Gerrit's standard events, if they should be
 * considered one group, e.g. normal and wip patchset uploads.
 *
 * 3. Everything beyond the ~ character is cut off from the tag. That gives
 * tools control over which messages will be hidden.
 */
function computeTag(message: CombinedMessage) {
  if (!message.tag) {
    const threads = message.commentThreads || [];
    const messageId = getMessageId(message);
    const comments = threads.map(t =>
      t.comments.find(c => c.change_message_id === messageId)
    );
    const hasRobotComments = comments.some(isRobot);
    return hasRobotComments ? 'autogenerated:has-robot-comments' : undefined;
  }

  if (message.tag === MessageTag.TAG_NEW_WIP_PATCHSET) {
    return MessageTag.TAG_NEW_PATCHSET;
  }
  if (message.tag === MessageTag.TAG_UNSET_ASSIGNEE) {
    return MessageTag.TAG_SET_ASSIGNEE;
  }
  if (message.tag === MessageTag.TAG_UNSET_PRIVATE) {
    return MessageTag.TAG_SET_PRIVATE;
  }
  if (message.tag === MessageTag.TAG_SET_WIP) {
    return MessageTag.TAG_SET_READY;
  }

  return message.tag.replace(/~.*/, '');
}

/**
 * Try to set a revision number that makes sense, if none is set. Just copy
 * over the revision number of the next older message. This is mostly relevant
 * for reviewer updates. Other messages should typically have the revision
 * number already set.
 */
function computeRevision(
  message: CombinedMessage,
  allMessages: CombinedMessage[]
): PatchSetNum | undefined {
  if (message._revision_number && message._revision_number > 0)
    return message._revision_number;
  let revision: PatchSetNum = 0 as PatchSetNum;
  for (const m of allMessages) {
    if (m.date > message.date) break;
    if (m._revision_number && m._revision_number > revision)
      revision = m._revision_number;
  }
  return revision > 0 ? revision : undefined;
}

/**
 * Unimportant messages are initially hidden.
 *
 * Human messages are always important. They have an undefined tag.
 *
 * Autogenerated messages are unimportant, if there is a message with the same
 * tag and a higher revision number.
 */
function computeIsImportant(
  message: CombinedMessage,
  allMessages: CombinedMessage[]
) {
  if (!message.tag) return true;

  const hasSameTag = (m: CombinedMessage) => m.tag === message.tag;
  const revNumber = message._revision_number || 0;
  const hasHigherRevisionNumber = (m: CombinedMessage) =>
    (m._revision_number || 0) > revNumber;
  return !allMessages.filter(hasSameTag).some(hasHigherRevisionNumber);
}

export const TEST_ONLY = {
  computeTag,
  computeRevision,
  computeIsImportant,
};

export interface GrMessagesList {
  $: {
    messageRepeat: DomRepeat;
  };
}

// This avoids JSC_DYNAMIC_EXTENDS_WITHOUT_JSDOC closure compiler error.
const base = KeyboardShortcutMixin(PolymerElement);

@customElement('gr-messages-list')
export class GrMessagesList extends base {
  static get template() {
    return htmlTemplate;
  }

  @property({type: Object})
  change?: ChangeViewChangeInfo;

  @property({type: String})
  changeNum?: ChangeId | NumericChangeId;

  @property({type: Array})
  messages: ChangeMessageInfo[] = [];

  @property({type: Array})
  reviewerUpdates: ReviewerUpdateInfo[] = [];

  @property({type: Object})
  changeComments?: ChangeComments;

  @property({type: String})
  projectName?: RepoName;

  @property({type: Boolean})
  showReplyButtons = false;

  @property({type: Object})
  labels?: LabelNameToInfoMap;

  @property({type: String})
  _expandAllState = ExpandAllState.EXPAND_ALL;

  @property({type: String, computed: '_computeExpandAllTitle(_expandAllState)'})
  _expandAllTitle = '';

  @property({type: Boolean, observer: '_observeShowAllActivity'})
  _showAllActivity = false;

  @property({
    type: Array,
    computed:
      '_computeCombinedMessages(messages, reviewerUpdates, ' +
      'changeComments)',
    observer: '_combinedMessagesChanged',
  })
  _combinedMessages: CombinedMessage[] = [];

  @property({type: Object, computed: '_computeLabelExtremes(labels.*)'})
  _labelExtremes: {[labelName: string]: VotingRangeInfo} = {};

  private readonly reporting = appContext.reportingService;

  scrollToMessage(messageID: string) {
    const selector = `[data-message-id="${messageID}"]`;
    const el = this.shadowRoot!.querySelector(selector) as
      | GrMessage
      | undefined;

    if (!el && this._showAllActivity) {
      this.reporting.error(
        new Error(`Failed to scroll to message: ${messageID}`)
      );
      return;
    }
    if (!el) {
      this._showAllActivity = true;
      setTimeout(() => this.scrollToMessage(messageID));
      return;
    }

    el.set('message.expanded', true);
    let top = el.offsetTop;
    for (
      let offsetParent = el.offsetParent as HTMLElement | null;
      offsetParent;
      offsetParent = offsetParent.offsetParent as HTMLElement | null
    ) {
      top += offsetParent.offsetTop;
    }
    window.scrollTo(0, top);
    this._highlightEl(el);
  }

  _observeShowAllActivity() {
    // We have to call render() such that the dom-repeat filter picks up the
    // change.
    this.$.messageRepeat.render();
  }

  /**
   * Filter for the dom-repeat of combinedMessages.
   */
  _isMessageVisible(message: CombinedMessage) {
    return this._showAllActivity || message.isImportant;
  }

  /**
   * Merges change messages and reviewer updates into one array. Also processes
   * all messages and updates, aligns or massages some of the properties.
   */
  _computeCombinedMessages(
    messages?: ChangeMessageInfo[],
    reviewerUpdates?: FormattedReviewerUpdateInfo[],
    changeComments?: ChangeComments
  ) {
    if (
      messages === undefined ||
      reviewerUpdates === undefined ||
      changeComments === undefined
    )
      return [];

    let mi = 0;
    let ri = 0;
    let combinedMessages: CombinedMessage[] = [];
    let mDate;
    let rDate;
    for (let i = 0; i < messages.length; i++) {
      // TODO(TS): clone message instead and avoid API object mutation
      (messages[i] as CombinedMessage)._index = i;
    }

    while (mi < messages.length || ri < reviewerUpdates.length) {
      if (mi >= messages.length) {
        combinedMessages = combinedMessages.concat(reviewerUpdates.slice(ri));
        break;
      }
      if (ri >= reviewerUpdates.length) {
        combinedMessages = combinedMessages.concat(messages.slice(mi));
        break;
      }
      mDate = mDate || parseDate(messages[mi].date);
      rDate = rDate || parseDate(reviewerUpdates[ri].date);
      if (rDate < mDate) {
        combinedMessages.push(reviewerUpdates[ri++]);
        rDate = null;
      } else {
        combinedMessages.push(messages[mi++]);
        mDate = null;
      }
    }

    const allThreadsForChange = changeComments.getAllThreadsForChange();
    // collapse all by default
    for (const thread of allThreadsForChange) {
      for (const comment of thread.comments) {
        comment.collapsed = true;
      }
    }

    for (let i = 0; i < combinedMessages.length; i++) {
      const message = combinedMessages[i];
      if (message.expanded === undefined) {
        message.expanded = false;
      }
      message.commentThreads = computeThreads(message, allThreadsForChange);
      message._revision_number = computeRevision(message, combinedMessages);
      message.tag = computeTag(message);
    }
    // computeIsImportant() depends on tags and revision numbers already being
    // updated for all messages, so we have to compute this in its own forEach
    // loop.
    combinedMessages.forEach(m => {
      m.isImportant = computeIsImportant(m, combinedMessages);
    });
    return combinedMessages;
  }

  _updateExpandedStateOfAllMessages(exp: boolean) {
    if (this._combinedMessages) {
      for (let i = 0; i < this._combinedMessages.length; i++) {
        this._combinedMessages[i].expanded = exp;
        this.notifyPath(`_combinedMessages.${i}.expanded`);
      }
    }
  }

  _computeExpandAllTitle(_expandAllState?: string) {
    if (_expandAllState === ExpandAllState.COLLAPSE_ALL) {
      return this.createTitle(
        Shortcut.COLLAPSE_ALL_MESSAGES,
        ShortcutSection.ACTIONS
      );
    }
    if (_expandAllState === ExpandAllState.EXPAND_ALL) {
      return this.createTitle(
        Shortcut.EXPAND_ALL_MESSAGES,
        ShortcutSection.ACTIONS
      );
    }
    return '';
  }

  _highlightEl(el: HTMLElement) {
    const highlightedEls = this.root!.querySelectorAll('.highlighted');
    for (const highlightedEl of highlightedEls) {
      highlightedEl.classList.remove('highlighted');
    }
    function handleAnimationEnd() {
      el.removeEventListener('animationend', handleAnimationEnd);
      el.classList.remove('highlighted');
    }
    el.addEventListener('animationend', handleAnimationEnd);
    el.classList.add('highlighted');
  }

  handleExpandCollapse(expand: boolean) {
    this._expandAllState = expand
      ? ExpandAllState.COLLAPSE_ALL
      : ExpandAllState.EXPAND_ALL;
    this._updateExpandedStateOfAllMessages(expand);
  }

  _handleExpandCollapseTap(e: Event) {
    e.preventDefault();
    this.handleExpandCollapse(
      this._expandAllState === ExpandAllState.EXPAND_ALL
    );
  }

  _handleAnchorClick(e: CustomEvent<MessageAnchorTapDetail>) {
    this.scrollToMessage(e.detail.id);
  }

  _isVisibleShowAllActivityToggle(messages: CombinedMessage[] = []) {
    return messages.some(m => !m.isImportant);
  }

  _computeHiddenEntriesCount(messages: CombinedMessage[] = []) {
    return messages.filter(m => !m.isImportant).length;
  }

  /**
   * Called when this._combinedMessages has changed.
   */
  _combinedMessagesChanged(combinedMessages?: CombinedMessage[]) {
    if (!combinedMessages) return;
    if (combinedMessages.length === 0) return;
    for (let i = 0; i < combinedMessages.length; i++) {
      this.notifyPath(`_combinedMessages.${i}.commentThreads`);
    }
    const tags = combinedMessages.map(
      message =>
        message.tag || (message as FormattedReviewerUpdateInfo).type || 'none'
    );
    const tagsCounted = tags.reduce(
      (acc, val) => {
        acc[val] = (acc[val] || 0) + 1;
        return acc;
      },
      {all: combinedMessages.length} as TagsCountReportInfo
    );
    this.reporting.reportInteraction('messages-count', tagsCounted);
  }

  /**
   * Compute a mapping from label name to objects representing the minimum and
   * maximum possible values for that label.
   */
  _computeLabelExtremes(
    labelRecord: PolymerDeepPropertyChange<
      LabelNameToInfoMap,
      LabelNameToInfoMap
    >
  ) {
    const extremes: {[labelName: string]: VotingRangeInfo} = {};
    const labels = labelRecord.base;
    if (!labels) {
      return extremes;
    }
    for (const key of Object.keys(labels)) {
      const range = getVotingRange(labels[key]);
      if (range) {
        extremes[key] = range;
      }
    }
    return extremes;
  }

  /**
   * Work around a issue on iOS when clicking turns into double tap
   */
  _onTapShowAllActivityToggle(e: Event) {
    e.preventDefault();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gr-messages-list': GrMessagesList;
  }
}
