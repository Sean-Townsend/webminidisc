import React, { useEffect, useCallback, useState } from 'react';
import { useDeviceCapabilities, useDispatch } from '../frontend-utils';
import { FileRejection, useDropzone } from 'react-dropzone';
import { listContent, deleteTracks, moveTrack, groupTracks, deleteGroups, ejectDisc, flushDevice } from '../redux/actions';
import { actions as renameDialogActions, RenameType } from '../redux/rename-dialog-feature';
import { actions as convertDialogActions } from '../redux/convert-dialog-feature';
import { actions as dumpDialogActions } from '../redux/dump-dialog-feature';
import { actions as appStateActions } from '../redux/app-feature';
import { actions as contextMenuActions } from '../redux/context-menu-feature';

import { DeviceStatus } from 'netmd-js';
import { control, openLocalLibrary } from '../redux/actions';

import {
    formatTimeFromSeconds,
    getGroupedTracks,
    getTagGroupedTracks,
    getSortedTracks,
    isSequential,
    acceptedTypes,
    AdaptiveFile,
    bytesToHumanReadable,
    TrackListViewMode,
} from '../utils';
import { forAnyDesktop, useShallowEqualSelector, themeSpacing, batchActions } from '../frontend-utils';

import { makeStyles } from 'tss-react/mui';
import { alpha, lighten } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import Backdrop from '@mui/material/Backdrop';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import EjectIcon from '@mui/icons-material/Eject';
import DoneIcon from '@mui/icons-material/Done';

import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import LinearProgress from '@mui/material/LinearProgress';

import IconButton from '@mui/material/IconButton';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';

import { LeftInNondefaultCodecs } from './main-rows';
import { VirtualTrackList, flattenGroupedTracks } from './virtual-track-list';
import { RenameDialog } from './rename-dialog';
import { UploadDialog } from './upload-dialog';
import { RecordDialog } from './record-dialog';
import { ErrorDialog } from './error-dialog';
import { PanicDialog } from './panic-dialog';
import { ConvertDialog } from './convert-dialog';
import { AboutDialog } from './about-dialog';
import { DumpDialog } from './dump-dialog';
import { TopMenu } from './topmenu';
import Checkbox from '@mui/material/Checkbox';
import Button from '@mui/material/Button';
import { W95Main } from './win95/main';
import { useMemo } from 'react';
import { ChangelogDialog } from './changelog-dialog';
import { getDefaultCodecName, Track } from '../services/interfaces/netmd';
import { FactoryModeNoticeDialog } from './factory/factory-notice-dialog';
import { FactoryModeProgressDialog } from './factory/factory-progress-dialog';
import { SongRecognitionDialog } from './song-recognition-dialog';
import { SongRecognitionProgressDialog } from './song-recognition-progress-dialog';
import { SettingsDialog } from './settings-dialog';
import { FactoryModeBadSectorDialog } from './factory/factory-bad-sector-dialog';
import { DiscProtectedDialog } from './disc-protected-dialog';
import { ContextMenu } from './context-menu';
import { LocalLibraryDialog } from './local-library';
import { Menu, MenuItem } from '@mui/material';
import serviceRegistry from '../services/registry';

// TODO jss-to-tss-react codemod: Unable to handle style definition reliably. Unsupported arrow function syntax.
//Unexpected value type of ConditionalExpression.
const useStyles = makeStyles()((theme) => ({
    main: {
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        flex: '1 1 auto',
        marginBottom: theme.spacing(3),
        outline: 'none',
        marginLeft: theme.spacing(-1),
        marginRight: theme.spacing(-1),
        [forAnyDesktop(theme)]: {
            marginLeft: theme.spacing(-2),
            marginRight: theme.spacing(-2),
        },
    },
    toolbar: {
        marginTop: theme.spacing(2),
        marginLeft: theme.spacing(-2),
        marginRight: theme.spacing(-2),
        [theme.breakpoints.up(600 + themeSpacing(theme, 2) * 2)]: {
            marginLeft: theme.spacing(-3),
            marginRight: theme.spacing(-3),
        },
    },
    toolbarLabel: {
        flex: '1 1 100%',
    },
    viewModeGroup: {
        marginRight: theme.spacing(1),
    },
    toolbarHighlight:
        theme.palette.mode === 'light'
            ? {
                  color: theme.palette.secondary.main,
                  backgroundColor: lighten(theme.palette.secondary.light, 0.85),
              }
            : {
                  color: theme.palette.text.primary,
                  backgroundColor: theme.palette.secondary.dark,
              },
    headBox: {
        display: 'flex',
        justifyContent: 'space-between',
    },
    spacing: {
        marginTop: theme.spacing(1),
    },
    indexCell: {
        whiteSpace: 'nowrap',
        paddingRight: 0,
        width: theme.spacing(4),
    },
    backdrop: {
        zIndex: theme.zIndex.drawer + 1,
        color: '#fff',
    },
    remainingTimeTooltip: {
        textDecoration: 'underline',
        textDecorationStyle: 'dotted',
    },
    hoveringOverGroup: {
        backgroundColor: `${alpha(theme.palette.secondary.dark, 0.4)}`,
    },
    dragHandleEmpty: {
        width: 20,
        padding: `${theme.spacing(0.5)} 0 0 0`,
    },
    fixedTable: {
        tableLayout: 'fixed',
    },
    topbarButton: {
        marginRight: theme.spacing(0.5),
    },
    topbarLargeButton: {
        marginRight: theme.spacing(0.5),
        minWidth: 'min-content',
    },
    clickableRemainingTime: {
        cursor: 'pointer',
    },
}));

function getTrackStatus(track: Track, deviceStatus: DeviceStatus | null): 'playing' | 'paused' | 'none' {
    if (!deviceStatus || track.index !== deviceStatus.track) {
        return 'none';
    }

    if (deviceStatus.state === 'playing') {
        return 'playing';
    } else if (deviceStatus.state === 'paused') {
        return 'paused';
    } else {
        return 'none';
    }
}

export const Main = (props: {}) => {
    const dispatch = useDispatch();
    const disc = useShallowEqualSelector((state) => state.main.disc);
    const flushable = useShallowEqualSelector((state) => state.main.flushable);
    const deviceName = useShallowEqualSelector((state) => state.main.deviceName);
    const deviceStatus = useShallowEqualSelector((state) => state.main.deviceStatus);
    const factoryModeRippingInMainUi = useShallowEqualSelector((state) => state.appState.factoryModeRippingInMainUi);
    const { vintageMode } = useShallowEqualSelector((state) => state.appState);

    const [selected, setSelected] = React.useState<number[]>([]);
    const [selectedGroups, setSelectedGroups] = React.useState<number[]>([]);
    const [uploadedFiles, setUploadedFiles] = React.useState<(File | AdaptiveFile)[]>([]);
    const [lastClicked, setLastClicked] = useState(-1);
    const [moveMenuAnchorEl, setMoveMenuAnchorEl] = React.useState<null | HTMLElement>(null);
    const [showRemainingSpace, setShowRemainingSpace] = useState(true);
    // Collapse state is kept separately per view mode, so switching between Tracks/Albums/Artists
    // doesn't lose (or leak) collapse state from a different mode - group indices aren't even
    // comparable across modes (tag-derived Album/Artist views use synthetic negative indices,
    // unrelated to the device's real group indices used in Track view).
    const [collapsedGroupsByMode, setCollapsedGroupsByMode] = React.useState<Record<TrackListViewMode, Set<number>>>(() => ({
        track: new Set(),
        album: new Set(),
        artist: new Set(),
    }));
    const [viewMode, setViewMode] = React.useState<TrackListViewMode>('album');
    const collapsedGroups = collapsedGroupsByMode[viewMode];
    const setCollapsedGroups = useCallback(
        (updater: Set<number> | ((prev: Set<number>) => Set<number>)) => {
            setCollapsedGroupsByMode((prev) => ({
                ...prev,
                [viewMode]: typeof updater === 'function' ? (updater as (prev: Set<number>) => Set<number>)(prev[viewMode]) : updater,
            }));
        },
        [viewMode]
    );

    const deviceCapabilities = useDeviceCapabilities();
    const minidiscSpec = serviceRegistry.netmdSpec;

    const handleShowMoveMenu = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            setMoveMenuAnchorEl(event.currentTarget);
        },
        [setMoveMenuAnchorEl]
    );
    const handleCloseMoveMenu = useCallback(() => {
        setMoveMenuAnchorEl(null);
    }, [setMoveMenuAnchorEl]);

    const handleMoveSelectedTrack = useCallback(
        (destIndex: number) => {
            dispatch(moveTrack(selected[0], destIndex));
            handleCloseMoveMenu();
        },
        [dispatch, selected, handleCloseMoveMenu]
    );

    const handleShowDumpDialog = useCallback(() => {
        dispatch(dumpDialogActions.setVisible(true));
    }, [dispatch]);

    useEffect(() => {
        dispatch(listContent());
    }, [dispatch]);

    useEffect(() => {
        // Reset selection if disc changes. Note this only fires when the disc's *identity*
        // (title, or null <-> non-null) changes - i.e. an actual different disc/device was
        // connected - not on every listContent() refresh. Deleting/renaming tracks, uploading,
        // etc. all trigger a content refresh (a brand new `disc` object) on the *same* disc, and
        // must not reset collapsed-album state or the user's current selection: previously they
        // did, which meant deleting tracks from one expanded album while others were collapsed
        // caused every album to silently re-expand once the delete finished.
        setSelected([]);
        setSelectedGroups([]);
        // Default to a fully-collapsed Album view on every fresh disc/device connection (Track
        // and Artist views start expanded, matching prior behavior) - collapsed will be filled
        // in properly once the real album list is known, by the effect below.
        setCollapsedGroupsByMode({ track: new Set(), album: new Set(), artist: new Set() });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [disc?.title, disc === null]);

    const [wasLastDiscNull, setWasLastDiscNull] = useState<boolean>(false);
    const discProtectedDialogDisabled = useShallowEqualSelector((state) => state.appState.discProtectedDialogDisabled);
    useEffect(() => {
        if (disc === null && !wasLastDiscNull) {
            setWasLastDiscNull(true);
            dispatch(appStateActions.showDiscProtectedDialog(false));
        } else if (disc !== null && wasLastDiscNull && disc.writeProtected && disc.writable) {
            setWasLastDiscNull(false);
            if (!discProtectedDialogDisabled) {
                dispatch(appStateActions.showDiscProtectedDialog(true));
            }
        }
    }, [dispatch, disc, wasLastDiscNull, discProtectedDialogDisabled, setWasLastDiscNull]);

    const onDrop = useCallback(
        (acceptedFiles: File[], rejectedFiles: FileRejection[]) => {
            const bannedTypes = ['audio/mpegurl', 'audio/x-mpegurl'];
            const accepted = acceptedFiles.filter((n) => !bannedTypes.includes(n.type));
            if (accepted.length > 0) {
                setUploadedFiles(accepted);
                dispatch(convertDialogActions.setVisible(true));
            }
        },
        [dispatch]
    );

    const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
        onDrop,
        accept: acceptedTypes,
        noClick: true,
        // react-dropzone tracks focus on its root element (#main, which wraps the whole track
        // list) purely to support opening the file picker via keyboard (Space/Enter). Since that
        // keyboard shortcut isn't used or needed here, `noKeyboard` disables that focus tracking
        // entirely (per react-dropzone's own docs: "it also stops tracking the focus state").
        // Without this, every native `focus` event on any interactive element inside the track
        // list (buttons, etc.) bubbles up to this root's onFocus handler, which dispatches into
        // react-dropzone's internal reducer and re-renders Main. When that re-render happens
        // between a button's mousedown and mouseup - which it does, since focus fires on
        // mousedown - the virtualized list's rows get torn down and rebuilt mid-click, and the
        // browser cancels the click because its target was removed from the DOM while pressed.
        // That's what caused chevron/delete clicks in the track list to silently do nothing.
        noKeyboard: true,
    });

    const { classes, cx } = useStyles();
    const tracks = useMemo(() => getSortedTracks(disc), [disc]);
    const deviceGroupedTracks = useMemo(() => getGroupedTracks(disc), [disc]);
    // Album/Artist view modes re-group by the tracks' own tags (see getTagGroupedTracks) rather
    // than the device's stored group boundaries, since those can fragment a single album into
    // many single-track groups when tagging is inconsistent between tracks. This is view-only -
    // it's never passed to group rename/delete, which still operate on deviceGroupedTracks.
    const groupedTracks = useMemo(
        () => (viewMode === 'track' ? deviceGroupedTracks : getTagGroupedTracks(disc, viewMode)),
        [viewMode, deviceGroupedTracks, disc]
    );
    const isTagDerivedView = viewMode !== 'track';
    const flatRows = useMemo(() => flattenGroupedTracks(groupedTracks, collapsedGroups), [groupedTracks, collapsedGroups]);
    const namedGroupIndices = useMemo(() => groupedTracks.filter((g) => g.title !== null).map((g) => g.index), [groupedTracks]);
    const allGroupsCollapsed = namedGroupIndices.length > 0 && namedGroupIndices.every((idx) => collapsedGroups.has(idx));

    // Default all three views (Tracks, Albums, Artists) to fully collapsed as soon as real
    // content is available for a freshly-connected disc. This only fires once per disc identity
    // (tracked via defaultedForDiscRef) so it doesn't fight the user's own collapse/expand
    // choices on later content refreshes from the same disc (e.g. after deletes).
    const defaultedForDiscRef = React.useRef<string | null>(null);
    useEffect(() => {
        const discIdentity = disc === null ? null : disc.title ?? '';
        if (discIdentity === null || defaultedForDiscRef.current === discIdentity) {
            return;
        }
        const trackGroups = getGroupedTracks(disc);
        const albumGroups = getTagGroupedTracks(disc, 'album');
        const artistGroups = getTagGroupedTracks(disc, 'artist');
        const trackIndices = trackGroups.filter((g) => g.title !== null).map((g) => g.index);
        const albumIndices = albumGroups.filter((g) => g.title !== null).map((g) => g.index);
        const artistIndices = artistGroups.filter((g) => g.title !== null).map((g) => g.index);
        if (albumIndices.length === 0 && artistIndices.length === 0 && trackIndices.length === 0) {
            return; // Content not loaded yet (or genuinely no groups at all) - try again once it changes.
        }
        defaultedForDiscRef.current = discIdentity;
        setCollapsedGroupsByMode({
            track: new Set(trackIndices),
            album: new Set(albumIndices),
            artist: new Set(artistIndices),
        });
    }, [disc]);
    const defaultCodecName = minidiscSpec ? getDefaultCodecName(minidiscSpec) : '';

    const handleToggleCollapseGroup = useCallback(
        (event: React.MouseEvent, groupIdx: number) => {
            setCollapsedGroups((prev) => {
                const next = new Set(prev);
                if (next.has(groupIdx)) {
                    next.delete(groupIdx);
                } else {
                    next.add(groupIdx);
                }
                return next;
            });
        },
        [setCollapsedGroups]
    );

    const handleToggleCollapseAllGroups = useCallback(() => {
        setCollapsedGroups((prev) => (prev.size > 0 && allGroupsCollapsed ? new Set() : new Set(namedGroupIndices)));
    }, [allGroupsCollapsed, namedGroupIndices, setCollapsedGroups]);

    // Action Handlers
    const handleSelectTrackClick = useCallback(
        (event: React.MouseEvent, item: number) => {
            setSelectedGroups([]);
            if (event.shiftKey && selected.length && lastClicked !== -1) {
                const rangeBegin = Math.min(lastClicked + 1, item),
                    rangeEnd = Math.max(lastClicked - 1, item);
                const copy = [...selected];
                for (let i = rangeBegin; i <= rangeEnd; i++) {
                    const index = copy.indexOf(i);
                    if (index === -1) copy.push(i);
                    else copy.splice(index, 1);
                }
                if (!copy.includes(item)) copy.push(item);
                setSelected(copy);
            } else if (selected.includes(item)) {
                setSelected(selected.filter((i) => i !== item));
            } else {
                setSelected([...selected, item]);
            }
            setLastClicked(item);
        },
        [selected, setSelected, lastClicked, setLastClicked]
    );

    const handleOpenContextMenu = useCallback(
        (event: React.MouseEvent, track: Track) => {
            if (!track) return;
            event.preventDefault();
            dispatch(contextMenuActions.openContextMenu({ position: { x: event.clientX, y: event.clientY }, track: track }));
        },
        [dispatch]
    );

    const handleSelectGroupClick = useCallback(
        (event: React.MouseEvent, item: number) => {
            // In Album/Artist view, "groups" are synthetic (re-derived from tags for display
            // only) and don't correspond to any real device group, so group-level actions like
            // rename/delete/select don't apply - clicking just does nothing rather than acting on
            // a meaningless index.
            if (isTagDerivedView) return;
            setSelected([]);
            if (selectedGroups.includes(item)) {
                setSelectedGroups(selectedGroups.filter((i) => i !== item));
            } else {
                setSelectedGroups([...selectedGroups, item]);
            }
        },
        [isTagDerivedView, selectedGroups, setSelected, setSelectedGroups]
    );

    const handleSelectAllClick = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            setSelectedGroups([]);
            if (selected.length < tracks.length) {
                setSelected(tracks.map((t) => t.index));
            } else {
                setSelected([]);
            }
        },
        [selected, tracks, setSelected, setSelectedGroups]
    );

    const handleRenameTrack = useCallback(
        (event: React.MouseEvent, index: number) => {
            const track = tracks.find((t) => t.index === index);
            if (!track) {
                return;
            }

            dispatch(
                batchActions([
                    renameDialogActions.setVisible(true),
                    renameDialogActions.setHimdTitle(track.title),
                    renameDialogActions.setHimdAlbum(track.album ?? ''),
                    renameDialogActions.setHimdArtist(track.artist ?? ''),
                    renameDialogActions.setCurrentName(track.title),
                    renameDialogActions.setCurrentFullWidthName(track.fullWidthTitle),
                    renameDialogActions.setIndex(track.index),
                    renameDialogActions.setRenameType(
                        track.album !== undefined || track.album !== undefined ? RenameType.HIMD : RenameType.TRACK
                    ),
                ])
            );
        },
        [dispatch, tracks]
    );

    const handleRenameGroup = useCallback(
        (event: React.MouseEvent, index: number) => {
            if (isTagDerivedView) return; // Synthetic group in Album/Artist view - not renameable.
            const group = groupedTracks.find((g) => g.index === index);
            if (!group) {
                return;
            }

            dispatch(
                batchActions([
                    renameDialogActions.setVisible(true),
                    renameDialogActions.setIndex(index),
                    renameDialogActions.setCurrentName(group.title ?? ''),
                    renameDialogActions.setCurrentFullWidthName(group.fullWidthTitle ?? ''),
                    renameDialogActions.setRenameType(RenameType.GROUP),
                ])
            );
        },
        [dispatch, groupedTracks, isTagDerivedView]
    );

    const handleRenameActionClick = useCallback(
        (event: React.MouseEvent) => {
            if (event.detail !== 1) return; //Event retriggering when hitting enter in the dialog
            handleRenameTrack(event, selected[0]);
        },
        [handleRenameTrack, selected]
    );

    const handleDeleteSelected = useCallback(
        (event: React.MouseEvent) => {
            dispatch(deleteTracks(selected));
        },
        [dispatch, selected]
    );

    const handleDeleteTrack = useCallback(
        (event: React.MouseEvent, index: number) => {
            dispatch(deleteTracks([index]));
        },
        [dispatch]
    );

    const handleGroupTracks = useCallback(
        (event: React.MouseEvent) => {
            dispatch(groupTracks(selected));
        },
        [dispatch, selected]
    );

    const handleDeleteGroup = useCallback(
        (event: React.MouseEvent, index: number) => {
            event.stopPropagation();
            if (isTagDerivedView) return; // Synthetic group in Album/Artist view - nothing to ungroup.
            const group = groupedTracks.find((g) => g.index === index);
            const label = group?.title ? `"${group.title}"` : 'this album';
            if (
                !window.confirm(
                    `Ungroup ${label}?\n\nThis removes the album grouping. On some devices (e.g. Network Walkman) groups are derived from track tags and this has no effect; on others (NetMD/HiMD) it splits the tracks back out of the group. In both cases the tracks themselves are not deleted.`
                )
            ) {
                return;
            }
            dispatch(deleteGroups([index]));
        },
        [dispatch, groupedTracks, isTagDerivedView]
    );

    const handleDeleteSelectedGroups = useCallback(
        (event: React.MouseEvent) => {
            if (isTagDerivedView) return;
            if (
                !window.confirm(
                    `Ungroup ${selectedGroups.length} selected album${selectedGroups.length === 1 ? '' : 's'}?\n\nThis removes the album grouping. On some devices (e.g. Network Walkman) groups are derived from track tags and this has no effect; on others (NetMD/HiMD) it splits the tracks back out of the group. In both cases the tracks themselves are not deleted.`
                )
            ) {
                return;
            }
            dispatch(deleteGroups(selectedGroups));
            setSelectedGroups([]);
        },
        [dispatch, selectedGroups, setSelectedGroups, isTagDerivedView]
    );

    const handleEject = useCallback(
        (event: React.MouseEvent) => {
            dispatch(ejectDisc());
        },
        [dispatch]
    );

    const handleFlush = useCallback(
        (event: React.MouseEvent) => {
            dispatch(flushDevice());
        },
        [dispatch]
    );

    const handleRenameDisc = useCallback(
        (event: React.MouseEvent) => {
            if (!deviceCapabilities.metadataEdit) return;
            dispatch(
                batchActions([
                    renameDialogActions.setVisible(true),
                    renameDialogActions.setCurrentName(disc!.title),
                    renameDialogActions.setCurrentFullWidthName(disc!.fullWidthTitle),
                    renameDialogActions.setIndex(-1),
                    renameDialogActions.setRenameType(RenameType.DISC),
                ])
            );
        },
        [deviceCapabilities.metadataEdit, dispatch, disc]
    );

    const handleTogglePlayPauseTrack = useCallback(
        (event: React.MouseEvent, track: number) => {
            if (!deviceStatus) {
                return;
            }
            if (deviceStatus.track !== track) {
                dispatch(control('goto', track));
                dispatch(control('play'));
            } else if (deviceStatus.state === 'playing') {
                dispatch(control('pause'));
            } else {
                dispatch(control('play'));
            }
        },
        [dispatch, deviceStatus]
    );

    const canGroup = useMemo(() => {
        if (isTagDerivedView) return false; // "Group" creates a real device group from selected tracks' positions - meaningless while browsing a tag-derived view.
        return (
            tracks.filter((n) => n.group === null && selected.includes(n.index)).length === selected.length &&
            isSequential(selected.sort((a, b) => a - b))
        );
    }, [tracks, selected, isTagDerivedView]);

    const selectedCount = selected.length;
    const selectedGroupsCount = selectedGroups.length;

    const [uploadMenuAnchorEl, setUploadMenuAnchorEl] = React.useState<null | HTMLElement>(null);

    const openUploadMenu = useCallback(
        (ev: any) => {
            if (serviceRegistry.libraryService) {
                setUploadMenuAnchorEl(ev.currentTarget);
            } else {
                open();
            }
        },
        [open, setUploadMenuAnchorEl]
    );

    const handleOpenLocalLibrary = useCallback(() => {
        setUploadedFiles([]);
        setUploadMenuAnchorEl(null);
        dispatch(openLocalLibrary());
    }, [dispatch]);

    if (vintageMode) {
        const p = {
            disc,
            deviceName,

            factoryModeRippingInMainUi,

            selected,
            setSelected,
            selectedCount,
            isUsingBytes: minidiscSpec?.measurementUnits == 'bytes',

            tracks,
            uploadedFiles,
            setUploadedFiles,

            onDrop,
            getRootProps,
            getInputProps,
            isDragActive,
            open,

            moveMenuAnchorEl,
            setMoveMenuAnchorEl,

            handleShowMoveMenu,
            handleCloseMoveMenu,
            handleMoveSelectedTrack,
            handleShowDumpDialog,
            handleDeleteSelected,
            handleRenameActionClick,
            handleRenameTrack,
            handleSelectAllClick,
            handleSelectTrackClick,
        };
        return <W95Main {...p} />;
    }

    return (
        <React.Fragment>
            <Box className={classes.headBox}>
                <Typography component="h1" variant="h4">
                    {deviceName || `Loading...`}
                </Typography>
                <span>
                    {deviceCapabilities.trackUpload && (
                        <Tooltip title="Upload tracks">
                            <IconButton aria-label="add" onClick={openUploadMenu} disabled={!disc}>
                                <AddIcon />
                            </IconButton>
                        </Tooltip>
                    )}

                    {deviceCapabilities.discEject && (
                        <IconButton
                            aria-label="actions"
                            aria-controls="actions-menu"
                            aria-haspopup="true"
                            onClick={handleEject}
                            disabled={!disc}
                        >
                            <EjectIcon />
                        </IconButton>
                    )}

                    {flushable && (
                        <Tooltip title="Commit changes">
                            <IconButton aria-label="actions" aria-controls="actions-menu" aria-haspopup="true" onClick={handleFlush}>
                                <DoneIcon />
                            </IconButton>
                        </Tooltip>
                    )}

                    <TopMenu tracksSelected={selected} />
                </span>
            </Box>
            <Typography component="h2" variant="body2">
                {disc !== null ? (
                    <React.Fragment>
                        <span className={classes.clickableRemainingTime} onClick={() => setShowRemainingSpace((x) => !x)}>
                            {showRemainingSpace ? (
                                <>
                                    {minidiscSpec?.measurementUnits === 'frames' ? (
                                        <>
                                            <span>{`${formatTimeFromSeconds(disc.left)} left of ${formatTimeFromSeconds(disc.total)} `}</span>
                                            <Tooltip title={LeftInNondefaultCodecs(disc.left)} arrow>
                                                <span className={classes.remainingTimeTooltip}>{defaultCodecName} Mode</span>
                                            </Tooltip>
                                        </>
                                    ) : (
                                        <>
                                            <span>{`${bytesToHumanReadable(disc.left)} left of ${bytesToHumanReadable(disc.total)} `}</span>
                                        </>
                                    )}
                                </>
                            ) : (
                                <>
                                    {minidiscSpec?.measurementUnits === 'frames' ? (
                                        <>
                                            <span>
                                                {`${formatTimeFromSeconds(disc.used)} of ${formatTimeFromSeconds(disc.total)} `}{' '}
                                                {defaultCodecName} Mode
                                            </span>
                                        </>
                                    ) : (
                                        <>
                                            <span>{`${bytesToHumanReadable(disc.used)} of ${bytesToHumanReadable(disc.total)} `}</span>
                                        </>
                                    )}
                                </>
                            )}
                        </span>
                        <div className={classes.spacing} />
                        <LinearProgress
                            variant="determinate"
                            color={((disc.total - disc.left) * 100) / disc.total >= 90 ? 'secondary' : 'primary'}
                            value={((disc.total - disc.left) * 100) / disc.total}
                        />
                    </React.Fragment>
                ) : (
                    `No disc loaded`
                )}
            </Typography>
            <Toolbar
                className={cx(classes.toolbar, {
                    [classes.toolbarHighlight]: selectedCount > 0 || selectedGroupsCount > 0,
                })}
            >
                {selectedCount > 0 || selectedGroupsCount > 0 ? (
                    <Checkbox
                        indeterminate={selectedCount > 0 && selectedCount < tracks.length}
                        checked={selectedCount > 0}
                        disabled={selectedGroupsCount > 0}
                        color="secondary"
                        onChange={handleSelectAllClick}
                        inputProps={{ 'aria-label': 'select all tracks' }}
                    />
                ) : null}
                {selectedCount > 0 || selectedGroupsCount > 0 ? (
                    <Typography className={classes.toolbarLabel} color="inherit" variant="subtitle1">
                        {selectedCount || selectedGroupsCount} selected
                    </Typography>
                ) : (
                    <Typography onDoubleClick={handleRenameDisc} component="h3" variant="h6" className={classes.toolbarLabel}>
                        {disc?.fullWidthTitle && `${disc.fullWidthTitle} / `}
                        {disc ? disc?.title || `Untitled Disc` : ''}
                    </Typography>
                )}
                {selectedCount === 0 && selectedGroupsCount === 0 ? (
                    <ToggleButtonGroup
                        size="small"
                        exclusive
                        value={viewMode}
                        onChange={(event, newMode) => newMode !== null && setViewMode(newMode)}
                        aria-label="track list view mode"
                        className={classes.viewModeGroup}
                    >
                        <ToggleButton value="track" aria-label="track view">
                            Tracks
                        </ToggleButton>
                        <ToggleButton value="album" aria-label="album view">
                            Albums
                        </ToggleButton>
                        <ToggleButton value="artist" aria-label="artist view">
                            Artists
                        </ToggleButton>
                    </ToggleButtonGroup>
                ) : null}
                {selectedCount === 0 && selectedGroupsCount === 0 && namedGroupIndices.length > 0 ? (
                    <Tooltip title={allGroupsCollapsed ? 'Expand all albums' : 'Collapse all albums'}>
                        <IconButton
                            className={classes.topbarButton}
                            aria-label={allGroupsCollapsed ? 'expand all albums' : 'collapse all albums'}
                            onClick={handleToggleCollapseAllGroups}
                        >
                            {allGroupsCollapsed ? <UnfoldMoreIcon /> : <UnfoldLessIcon />}
                        </IconButton>
                    </Tooltip>
                ) : null}
                {selectedCount > 0 ? (
                    <React.Fragment>
                        <Tooltip title={`${deviceCapabilities.trackDownload ? 'Download' : 'Record'} from MD`}>
                            <Button
                                className={classes.topbarLargeButton}
                                color="inherit"
                                aria-label={deviceCapabilities.trackDownload || factoryModeRippingInMainUi ? 'Download' : 'Record'}
                                onClick={handleShowDumpDialog}
                            >
                                {deviceCapabilities.trackDownload || factoryModeRippingInMainUi ? 'Download' : 'Record'}
                            </Button>
                        </Tooltip>
                    </React.Fragment>
                ) : null}

                {selectedCount > 0 ? (
                    <Tooltip title="Delete">
                        <span>
                            <IconButton
                                className={classes.topbarButton}
                                aria-label="delete"
                                disabled={!deviceCapabilities.metadataEdit}
                                onClick={handleDeleteSelected}
                            >
                                <DeleteIcon />
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {selectedCount > 0 ? (
                    <Tooltip title={canGroup ? 'Group' : ''}>
                        <span>
                            <IconButton
                                className={classes.topbarButton}
                                aria-label="group"
                                disabled={!canGroup || !deviceCapabilities.metadataEdit}
                                onClick={handleGroupTracks}
                            >
                                <CreateNewFolderIcon />
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {selectedCount > 0 ? (
                    <Tooltip title="Rename">
                        <span>
                            <IconButton
                                className={classes.topbarButton}
                                aria-label="rename"
                                disabled={selectedCount !== 1 || !deviceCapabilities.metadataEdit}
                                onClick={handleRenameActionClick}
                            >
                                <EditIcon />
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {selectedGroupsCount > 0 ? (
                    <Tooltip title="Ungroup">
                        <span>
                            <IconButton
                                className={classes.topbarButton}
                                aria-label="ungroup"
                                disabled={!deviceCapabilities.metadataEdit}
                                onClick={handleDeleteSelectedGroups}
                            >
                                <DeleteIcon />
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}

                {selectedGroupsCount > 0 ? (
                    <Tooltip title="Rename Group">
                        <span>
                            <IconButton
                                className={classes.topbarButton}
                                aria-label="rename group"
                                disabled={!deviceCapabilities.metadataEdit || selectedGroupsCount !== 1}
                                onClick={(e) => handleRenameGroup(e, selectedGroups[0])}
                            >
                                <EditIcon />
                            </IconButton>
                        </span>
                    </Tooltip>
                ) : null}
            </Toolbar>
            {deviceCapabilities.contentList ? (
                <Box className={classes.main} {...getRootProps()} id="main">
                    <input {...getInputProps()} />
                    <VirtualTrackList
                        rows={flatRows}
                        usesHimdTracks={deviceCapabilities.himdTitles}
                        groupsAreEditable={!isTagDerivedView}
                        selectedTracks={selected}
                        selectedGroups={selectedGroups}
                        getTrackStatus={(t) => getTrackStatus(t, deviceStatus)}
                        onSelectTrack={handleSelectTrackClick}
                        onSelectGroup={handleSelectGroupClick}
                        onRenameTrack={handleRenameTrack}
                        onRenameGroup={handleRenameGroup}
                        onDeleteGroup={handleDeleteGroup}
                        onToggleCollapseGroup={handleToggleCollapseGroup}
                        onTogglePlayPauseTrack={handleTogglePlayPauseTrack}
                        onOpenContextMenu={handleOpenContextMenu}
                    />
                    {isDragActive && deviceCapabilities.trackUpload ? (
                        <Backdrop className={classes.backdrop} open={isDragActive}>
                            Drop your Music to Upload
                        </Backdrop>
                    ) : null}
                </Box>
            ) : null}
            <Menu anchorEl={uploadMenuAnchorEl} open={Boolean(uploadMenuAnchorEl)} onClose={() => setUploadMenuAnchorEl(null)}>
                <MenuItem
                    onClick={() => {
                        setUploadMenuAnchorEl(null);
                        open();
                    }}
                >
                    Upload from this machine
                </MenuItem>
                <MenuItem onClick={handleOpenLocalLibrary}>Upload from library</MenuItem>
            </Menu>

            <DiscProtectedDialog />
            <UploadDialog />
            <RenameDialog />
            <ErrorDialog />
            <ConvertDialog files={uploadedFiles} />
            <RecordDialog />
            <FactoryModeProgressDialog />
            <FactoryModeBadSectorDialog />
            <DumpDialog
                trackIndexes={selected}
                isCapableOfDownload={deviceCapabilities.trackDownload || factoryModeRippingInMainUi}
                isExploitDownload={factoryModeRippingInMainUi}
            />
            <SongRecognitionDialog />
            <SongRecognitionProgressDialog />
            <FactoryModeNoticeDialog />
            <AboutDialog />
            <ChangelogDialog />
            <SettingsDialog />
            <LocalLibraryDialog setUploadedFiles={setUploadedFiles} />
            <PanicDialog />
            <ContextMenu onTogglePlayPause={handleTogglePlayPauseTrack} onRename={handleRenameTrack} onDelete={handleDeleteTrack} />
        </React.Fragment>
    );
};
export default Main;
