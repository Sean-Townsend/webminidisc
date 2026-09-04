import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { FixedSizeList, ListChildComponentProps } from 'react-window';
import { makeStyles } from 'tss-react/mui';
import { alpha, lighten } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import FolderIcon from '@mui/icons-material/Folder';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import { Group, Track } from '../services/interfaces/netmd';
import { formatTimeFromSeconds } from '../utils';
import serviceRegistry from '../services/registry';
import { useDeviceCapabilities } from '../frontend-utils';

/**
 * Performance note: this replaces the previous approach of rendering every
 * group/track as a real <table>/<TableRow> DOM node (via react-beautiful-dnd's
 * Droppable/Draggable per row) with a virtualized list (react-window) that only
 * ever mounts the rows currently visible in the viewport, plus a small overscan
 * buffer. For devices with large libraries (thousands of tracks), the previous
 * approach caused severe scrolling lag because thousands of live DOM nodes, each
 * wrapped in its own drag-and-drop-aware component, had to be kept in the tree at
 * once.
 *
 * Per-row drag-and-drop reordering has been removed as part of this change (tracks
 * are typically viewed/sorted alphabetically already, and per-row DnD does not
 * combine well with virtualization - most virtualization and DnD libraries are not
 * designed to interoperate). Reordering via the existing "Move" menu action
 * (selecting a track and choosing a destination index) is unaffected and still
 * works, since that mechanism never depended on react-beautiful-dnd.
 */

export const ROW_HEIGHT = 36;

export type FlatRow = { type: 'group'; group: Group; collapsed: boolean } | { type: 'track'; track: Track; inGroup: boolean };

/**
 * Stable, content-based key for a row (group or track), independent of the row's
 * position in the list. This matters because collapsing/expanding an album shifts
 * every row below it to a different index - if react-window identified rows purely
 * by index (its default), it would treat "row 5" as the same row before and after a
 * collapse even though it now represents completely different content, causing
 * components to receive new props without remounting cleanly (or vice versa),
 * which manifests as flaky/inconsistent click behavior on nested buttons.
 */
function rowKey(row: FlatRow): string {
    return row.type === 'group' ? `g${row.group.index}` : `t${row.track.index}`;
}

/**
 * The text a row is matched against for the type-to-jump feature below - a group's
 * title, or a track's title (falling back to "No Title" to mirror what's actually
 * displayed, so an untitled track is reachable by typing its literal placeholder text).
 */
function rowSearchText(row: FlatRow): string {
    return (row.type === 'group' ? row.group.title : row.track.title) || 'No Title';
}

/** How long a user has, after their last keystroke, to add another character to the
 * current search buffer before it's treated as a fresh search (Explorer-style typeahead). */
const TYPEAHEAD_TIMEOUT_MS = 1000;

/**
 * Flattens getGroupedTracks()'s Group[] into a single list of group-header and track rows,
 * suitable for virtualization. Tracks belonging to a group whose index is present in
 * `collapsedGroups` are omitted (Explorer-style collapse), leaving just the header row.
 */
export function flattenGroupedTracks(groupedTracks: Group[], collapsedGroups?: ReadonlySet<number>): FlatRow[] {
    const rows: FlatRow[] = [];
    for (const group of groupedTracks) {
        const isRealGroup = group.title !== null;
        const isCollapsed = isRealGroup && (collapsedGroups?.has(group.index) ?? false);
        if (isRealGroup) {
            rows.push({ type: 'group', group, collapsed: isCollapsed });
        }
        if (!isCollapsed) {
            for (const track of group.tracks) {
                rows.push({ type: 'track', track, inGroup: isRealGroup });
            }
        }
    }
    return rows;
}

const useStyles = makeStyles<{ hasHimdColumns: boolean }>()((theme, { hasHimdColumns }) => ({
    listContainer: {
        flex: '1 1 auto',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
    },
    headerRow: {
        display: 'grid',
        // The number column needs to fit 4-digit track numbers (up to 9999) plus a little
        // breathing room, since some devices hold several thousand tracks. columnGap adds a
        // visible gap between the number and the title (and the other columns), so they don't
        // crowd against each other.
        gridTemplateColumns: hasHimdColumns
            ? `5em minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto`
            : `5em minmax(0, 2fr) auto`,
        columnGap: theme.spacing(1.5),
        alignItems: 'center',
        padding: theme.spacing(0.5, 1),
        borderBottom: `1px solid ${theme.palette.divider}`,
        fontSize: '0.75rem',
        color: theme.palette.text.secondary,
        fontWeight: 500,
    },
    row: {
        display: 'grid',
        gridTemplateColumns: hasHimdColumns
            ? `5em minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto`
            : `5em minmax(0, 2fr) auto`,
        columnGap: theme.spacing(1.5),
        alignItems: 'center',
        padding: theme.spacing(0, 1),
        boxSizing: 'border-box',
        cursor: 'pointer',
        userSelect: 'none',
        '&:hover': {
            backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.05))',
        },
    },
    rowSelected:
        theme.palette.mode === 'light'
            ? {
                  backgroundColor: lighten(theme.palette.secondary.main, 0.85),
                  '&:hover': {
                      backgroundColor: lighten(theme.palette.secondary.main, 0.85),
                  },
              }
            : {
                  backgroundColor: alpha(theme.palette.secondary.main, 0.16),
                  '&:hover': {
                      backgroundColor: alpha(theme.palette.secondary.main, 0.16),
                  },
              },
    inGroupIndent: {
        paddingLeft: theme.spacing(3),
    },
    cell: {
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        paddingRight: theme.spacing(1),
    },
    // Deliberately does NOT clip overflow, unlike `cell`: the chevron IconButton needs a little
    // breathing room and must never have its hit area clipped by the narrow grid column it sits in.
    chevronCell: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    },
    durationCell: {
        whiteSpace: 'nowrap',
        textAlign: 'right',
    },
    durationCellSecondary: {
        whiteSpace: 'nowrap',
        textAlign: 'right',
        color: theme.palette.text.secondary,
    },
    formatBadge: {
        color: 'white',
        height: theme.spacing(2.5),
        fontSize: '0.75rem',
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '10px',
        backgroundColor: theme.palette.primary.main,
        border: `2px solid ${theme.palette.background.paper}`,
        padding: '0 4px',
        marginRight: theme.spacing(0.5),
    },
    channelBadge: {
        display: 'inline-flex',
        padding: '0 4px',
        marginRight: theme.spacing(0.5),
        color: theme.palette.text.secondary,
    },
    // Offsets the "Title" header label to sit above the actual title text in rows below it,
    // not the folder/play-pause icon that precedes that text within the same grid column.
    // Must be kept equal to controlButton's width.
    titleHeaderOffset: {
        paddingLeft: theme.spacing(2.5),
    },
    controlButton: {
        width: theme.spacing(2.5),
        height: theme.spacing(2.5),
        marginRight: theme.spacing(0.5),
    },
    groupFolderIcon: {},
    deleteGroupButton: {
        display: 'none',
    },
    groupHeadRow: {
        '&:hover': {
            [`& .${'__deleteGroupButton__'}`]: {},
        },
    },
}));

interface VirtualGroupRowProps {
    group: Group;
    collapsed: boolean;
    isSelected: boolean;
    usesHimdTracks: boolean;
    /** False for synthetic, tag-derived groups (Album/Artist view modes) - these don't correspond
     * to any real device group, so rename/delete affordances are hidden rather than shown as
     * dead controls that silently do nothing when clicked. */
    isEditableGroup: boolean;
    onRename: (event: React.MouseEvent, groupIdx: number) => void;
    onDelete: (event: React.MouseEvent, groupIdx: number) => void;
    onSelect: (event: React.MouseEvent, groupIdx: number) => void;
    onToggleCollapse: (event: React.MouseEvent, groupIdx: number) => void;
}

function VirtualGroupRow({
    group,
    collapsed,
    isSelected,
    usesHimdTracks,
    isEditableGroup,
    onRename,
    onDelete,
    onSelect,
    onToggleCollapse,
}: VirtualGroupRowProps) {
    const { classes, cx } = useStyles({ hasHimdColumns: usesHimdTracks });
    const deviceCapabilities = useDeviceCapabilities();
    const [hovered, setHovered] = React.useState(false);

    const canEdit = isEditableGroup && deviceCapabilities.metadataEdit;

    const handleDelete = useCallback(
        (event: React.MouseEvent) => {
            event.stopPropagation();
            canEdit && onDelete(event, group.index);
        },
        [canEdit, onDelete, group.index]
    );
    const handleRename = useCallback(
        (event: React.MouseEvent) => canEdit && onRename(event, group.index),
        [canEdit, onRename, group.index]
    );
    const handleSelect = useCallback((event: React.MouseEvent) => onSelect(event, group.index), [onSelect, group.index]);
    const handleToggleCollapse = useCallback(
        (event: React.MouseEvent) => {
            event.stopPropagation();
            onToggleCollapse(event, group.index);
        },
        [onToggleCollapse, group.index]
    );

    const totalDuration = useMemo(() => group.tracks.map((n) => n.duration).reduce((a, b) => a + b, 0), [group.tracks]);

    return (
        <div
            className={cx(classes.row, { [classes.rowSelected]: isSelected })}
            onClick={handleSelect}
            onDoubleClick={handleRename}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            <div className={classes.chevronCell}>
                <IconButton
                    aria-label={collapsed ? 'expand album' : 'collapse album'}
                    className={classes.controlButton}
                    size="small"
                    onClick={handleToggleCollapse}
                >
                    {collapsed ? <ChevronRightIcon fontSize="inherit" /> : <ExpandMoreIcon fontSize="inherit" />}
                </IconButton>
            </div>
            <div className={classes.cell} title={group.title ?? ''}>
                {hovered && canEdit ? (
                    <IconButton aria-label="delete" className={classes.controlButton} size="small" onClick={handleDelete}>
                        <DeleteIcon fontSize="inherit" />
                    </IconButton>
                ) : (
                    <FolderIcon className={classes.controlButton} fontSize="inherit" />
                )}
                {group.fullWidthTitle ? `${group.fullWidthTitle} / ` : ``}
                {group.title || `No Name`}
                {collapsed ? ` (${group.tracks.length})` : ``}
            </div>
            {usesHimdTracks && (
                <>
                    <div className={classes.cell} />
                    <div className={classes.cell} />
                </>
            )}
            <div className={classes.durationCellSecondary}>{formatTimeFromSeconds(totalDuration)}</div>
        </div>
    );
}

interface VirtualTrackRowProps {
    track: Track;
    inGroup: boolean;
    isSelected: boolean;
    trackStatus: 'playing' | 'paused' | 'none';
    isHimdTrack: boolean;
    onSelect: (event: React.MouseEvent, trackIdx: number) => void;
    onRename: (event: React.MouseEvent, trackIdx: number) => void;
    onTogglePlayPause: (event: React.MouseEvent, trackIdx: number) => void;
    onOpenContextMenu: (event: React.MouseEvent, track: Track) => void;
}

function VirtualTrackRow({
    track,
    inGroup,
    isSelected,
    trackStatus,
    isHimdTrack,
    onSelect,
    onRename,
    onTogglePlayPause,
    onOpenContextMenu,
}: VirtualTrackRowProps) {
    const { classes, cx } = useStyles({ hasHimdColumns: isHimdTrack });
    const deviceCapabilities = useDeviceCapabilities();
    const [hovered, setHovered] = React.useState(false);

    const minidiscSpec = serviceRegistry.netmdSpec;
    const formatInfo = minidiscSpec?.availableFormats.find(
        (e) => e.codec === track.encoding.codec && e.availableBitrates.includes(track.encoding.bitrate)
    );

    const handleRename = useCallback(
        (event: React.MouseEvent) => deviceCapabilities.metadataEdit && onRename(event, track.index),
        [deviceCapabilities.metadataEdit, onRename, track.index]
    );
    const handleSelect = useCallback((event: React.MouseEvent) => onSelect(event, track.index), [track.index, onSelect]);
    const handleContextMenu = useCallback((event: React.MouseEvent) => onOpenContextMenu(event, track), [onOpenContextMenu, track]);
    const handlePlayPause: React.MouseEventHandler = useCallback(
        (event) => {
            event.stopPropagation();
            onTogglePlayPause(event, track.index);
        },
        [track.index, onTogglePlayPause]
    );
    const isPlayingOrPaused = trackStatus === 'playing' || trackStatus === 'paused';

    return (
        <div
            className={cx(classes.row, { [classes.rowSelected]: isSelected })}
            onClick={handleSelect}
            onDoubleClick={handleRename}
            onContextMenu={handleContextMenu}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={isPlayingOrPaused ? { color: 'inherit' } : undefined}
        >
            <div className={classes.cell} style={{ textAlign: 'right' }}>
                {hovered && deviceCapabilities.playbackControl ? (
                    <IconButton
                        aria-label="play/pause"
                        className={classes.controlButton}
                        size="small"
                        onClick={handlePlayPause}
                        onDoubleClick={(e) => e.stopPropagation()}
                    >
                        {trackStatus === 'paused' || trackStatus === 'none' ? (
                            <PlayArrowIcon fontSize="inherit" />
                        ) : (
                            <PauseIcon fontSize="inherit" />
                        )}
                    </IconButton>
                ) : (
                    <span>{track.index + 1}</span>
                )}
            </div>
            <div className={cx(classes.cell, { [classes.inGroupIndent]: inGroup })} title={track.title ?? ''}>
                {track.fullWidthTitle ? `${track.fullWidthTitle} / ` : ``}
                {track.title || `No Title`}
            </div>
            {isHimdTrack && (
                <>
                    <div className={classes.cell} title={track.album ?? ''}>
                        {track.album || `No Album`}
                    </div>
                    <div className={classes.cell} title={track.artist ?? ''}>
                        {track.artist || `No Artist`}
                    </div>
                </>
            )}
            <div className={classes.durationCell}>
                {track.channel === 1 && <span className={classes.channelBadge}>MONO</span>}
                {!formatInfo || formatInfo.availableBitrates.length > 1 ? (
                    <Tooltip title={`${track.encoding.bitrate!} kbps`}>
                        <span className={classes.formatBadge}>{track.encoding.codec}</span>
                    </Tooltip>
                ) : (
                    <span className={classes.formatBadge}>
                        {formatInfo.displayBadgeFriendlyName ?? formatInfo.userFriendlyName ?? formatInfo.codec}
                    </span>
                )}
                <span>{formatTimeFromSeconds(track.duration)}</span>
            </div>
        </div>
    );
}

export interface VirtualTrackListProps {
    rows: FlatRow[];
    usesHimdTracks: boolean;
    /** See VirtualGroupRowProps.isEditableGroup - false when groups are tag-derived (Album/Artist view). */
    groupsAreEditable: boolean;
    selectedTracks: number[];
    selectedGroups: number[];
    getTrackStatus: (track: Track) => 'playing' | 'paused' | 'none';
    onSelectTrack: (event: React.MouseEvent, trackIdx: number) => void;
    onSelectGroup: (event: React.MouseEvent, groupIdx: number) => void;
    onRenameTrack: (event: React.MouseEvent, trackIdx: number) => void;
    onRenameGroup: (event: React.MouseEvent, groupIdx: number) => void;
    onDeleteGroup: (event: React.MouseEvent, groupIdx: number) => void;
    onToggleCollapseGroup: (event: React.MouseEvent, groupIdx: number) => void;
    onTogglePlayPauseTrack: (event: React.MouseEvent, trackIdx: number) => void;
    onOpenContextMenu: (event: React.MouseEvent, track: Track) => void;
}

/**
 * Renders the header (fixed, non-virtualized - it's a single row) plus the
 * virtualized, scrollable body of group-header and track rows.
 */
export function VirtualTrackList({
    rows,
    usesHimdTracks,
    groupsAreEditable,
    selectedTracks,
    selectedGroups,
    getTrackStatus,
    onSelectTrack,
    onSelectGroup,
    onRenameTrack,
    onRenameGroup,
    onDeleteGroup,
    onToggleCollapseGroup,
    onTogglePlayPauseTrack,
    onOpenContextMenu,
}: VirtualTrackListProps) {
    const { classes } = useStyles({ hasHimdColumns: usesHimdTracks });
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<FixedSizeList>(null);

    /**
     * Explorer-style type-to-jump: typing a letter (or several letters in quick
     * succession) scrolls the list to the next row whose title starts with that
     * text, cycling back to the top once the end is reached. Repeatedly pressing
     * the same single letter cycles through every match for that letter, matching
     * the behaviour Windows Explorer and most native list views use.
     *
     * Listens on `window` rather than requiring the list itself to hold keyboard
     * focus first: nothing inside the list is focused by default when a disc's
     * content first loads (the user hasn't clicked a row yet), so a focus-only
     * listener would silently do nothing until the user happened to click inside
     * the list first - indistinguishable from "doesn't work" from the outside.
     */
    const typeaheadRef = useRef({ buffer: '', lastTime: 0, lastMatchIndex: -1 });
    useEffect(() => {
        const handleWindowKeyDown = (event: KeyboardEvent) => {
            // Single printable character only - avoid hijacking Ctrl/Alt/Meta combos,
            // arrow keys, Enter, Delete, etc.
            if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;

            // Don't hijack typing into text inputs, dialogs, contenteditable areas, etc.
            // (rename dialog, settings fields, custom-parameter inputs, ...).
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

            const now = Date.now();
            const state = typeaheadRef.current;
            const isFreshSearch = now - state.lastTime > TYPEAHEAD_TIMEOUT_MS;
            const typedChar = event.key.toLowerCase();
            // Repeatedly typing the *same* single character cycles through matches
            // rather than requiring the search text to keep growing, e.g. pressing
            // "h" three times jumps to the 1st, then 2nd, then 3rd title starting with "h".
            const isRepeatOfSameChar = !isFreshSearch && state.buffer.length === 1 && state.buffer === typedChar;
            state.buffer = isFreshSearch || isRepeatOfSameChar ? typedChar : state.buffer + typedChar;
            state.lastTime = now;

            const searchFrom = isRepeatOfSameChar ? state.lastMatchIndex + 1 : 0;
            const query = state.buffer;
            let matchIndex = -1;
            for (let i = 0; i < rows.length; i++) {
                const idx = (searchFrom + i) % rows.length;
                if (rowSearchText(rows[idx]).toLowerCase().startsWith(query)) {
                    matchIndex = idx;
                    break;
                }
            }

            if (matchIndex !== -1) {
                state.lastMatchIndex = matchIndex;
                listRef.current?.scrollToItem(matchIndex, 'smart');
                event.preventDefault();
            }
        };

        window.addEventListener('keydown', handleWindowKeyDown);
        return () => window.removeEventListener('keydown', handleWindowKeyDown);
    }, [rows]);

    const Row = useCallback(
        ({ index, style }: ListChildComponentProps) => {
            const row = rows[index];
            if (row.type === 'group') {
                return (
                    <div style={style}>
                        <VirtualGroupRow
                            group={row.group}
                            collapsed={row.collapsed}
                            isSelected={selectedGroups.includes(row.group.index)}
                            usesHimdTracks={usesHimdTracks}
                            isEditableGroup={groupsAreEditable}
                            onRename={onRenameGroup}
                            onDelete={onDeleteGroup}
                            onSelect={onSelectGroup}
                            onToggleCollapse={onToggleCollapseGroup}
                        />
                    </div>
                );
            }
            return (
                <div style={style}>
                    <VirtualTrackRow
                        track={row.track}
                        inGroup={row.inGroup}
                        isSelected={selectedTracks.includes(row.track.index)}
                        trackStatus={getTrackStatus(row.track)}
                        isHimdTrack={usesHimdTracks}
                        onSelect={onSelectTrack}
                        onRename={onRenameTrack}
                        onTogglePlayPause={onTogglePlayPauseTrack}
                        onOpenContextMenu={onOpenContextMenu}
                    />
                </div>
            );
        },
        [
            rows,
            selectedGroups,
            selectedTracks,
            usesHimdTracks,
            groupsAreEditable,
            getTrackStatus,
            onSelectTrack,
            onSelectGroup,
            onRenameTrack,
            onRenameGroup,
            onDeleteGroup,
            onToggleCollapseGroup,
            onTogglePlayPauseTrack,
            onOpenContextMenu,
        ]
    );

    return (
        <div className={classes.listContainer} ref={containerRef}>
            <div className={classes.headerRow}>
                <div style={{ textAlign: 'right' }}>#</div>
                {/* Group/track rows show a folder or play/pause icon inline before the title text
                    (both inside the same grid column), so the "Title" label needs a matching
                    left offset to sit directly above the actual title text, not the icon. */}
                <div className={classes.titleHeaderOffset}>Title</div>
                {usesHimdTracks && (
                    <>
                        <div>Album</div>
                        <div>Artist</div>
                    </>
                )}
                <div style={{ textAlign: 'right' }}>Duration</div>
            </div>
            <div style={{ flex: '1 1 auto', minHeight: 0 }}>
                <AutoSizedList listRef={listRef} itemCount={rows.length} rowRenderer={Row} itemKey={(index) => rowKey(rows[index])} />
            </div>
        </div>
    );
}

/**
 * Small wrapper that measures its own container size (react-window requires an
 * explicit height/width) using ResizeObserver, so the list fills whatever space
 * its parent's flex layout gives it, matching the previous table's `flex: 1 1 auto`
 * behavior.
 */
function AutoSizedList({
    listRef,
    itemCount,
    rowRenderer,
    itemKey,
}: {
    listRef?: React.RefObject<FixedSizeList>;
    itemCount: number;
    rowRenderer: (props: ListChildComponentProps) => JSX.Element;
    itemKey: (index: number) => React.Key;
}) {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [size, setSize] = React.useState({ width: 0, height: 0 });

    React.useEffect(() => {
        const el = wrapperRef.current;
        if (!el) return;
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            const width = Math.round(entry.contentRect.width);
            const height = Math.round(entry.contentRect.height);
            // Only update state (and thus remount FixedSizeList) when the size has actually
            // changed. Without this guard, spurious ResizeObserver callbacks - which can fire
            // for reasons unrelated to a real layout change (e.g. a button's focus/ripple effect,
            // or sub-pixel rounding noise) - cause setSize to run with an equivalent-but-new
            // object, remounting every row in the virtualized list. If that remount happens to
            // land between a button's mousedown and mouseup, the click is silently swallowed
            // (the browser cancels a click whose target was removed from the DOM mid-press),
            // which is exactly what caused the "chevron does nothing" bug.
            setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    return (
        <div ref={wrapperRef} style={{ width: '100%', height: '100%' }}>
            {size.width > 0 && size.height > 0 && (
                <FixedSizeList
                    ref={listRef}
                    height={size.height}
                    width={size.width}
                    itemCount={itemCount}
                    itemSize={ROW_HEIGHT}
                    overscanCount={8}
                    itemKey={itemKey}
                >
                    {rowRenderer}
                </FixedSizeList>
            )}
        </div>
    );
}
