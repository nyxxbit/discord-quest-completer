/*
 * OrionQuests — Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Shared types. Discord's internal Flux store shapes are loose by
 * nature — we describe only the fields we touch.
 */

export interface Quest {
    id: string;
    config?: {
        expiresAt?: string;
        application?: { id?: string; };
        messages?: { questName?: string; };
        taskConfig?: TaskConfig;
        taskConfigV2?: TaskConfig;
        rewardsConfig?: { rewards?: Array<{ type?: number; messages?: { name?: string; }; }>; };
    };
    userStatus?: {
        completedAt?: string;
        dismissedAt?: string;
        enrolledAt?: string;
        progress?: Record<string, { value?: number; }>;
        streamProgressSeconds?: number;
    };
}

export interface TaskConfig {
    tasks: Record<string, { target?: number; }>;
}

export type TaskType = "GAME" | "STREAM" | "WATCH_VIDEO" | "ACTIVITY" | "ACHIEVEMENT";

export interface DetectedTask {
    type: TaskType;
    keyName: string;
    target: number;
}

export interface TaskInfo {
    id: string;
    appId: string | number;
    name: string;
    target: number;
    type: TaskType;
    keyName: string;
}

export interface Stores {
    QuestStore: any;
    RunStore: any;
    StreamStore: any;
    ChanStore: any;
    GuildChanStore: any;
    Dispatcher: any;
    API: any;
}

export interface FakeGame {
    id: string | number;
    name: string;
    icon?: string;
    pid: number;
    pidPath: number[];
    processName: string;
    start: number;
    exeName: string;
    exePath: string;
    cmdLine: string;
    executables: Array<{ os: string; name: string; is_launcher: boolean; }>;
    windowHandle: number;
    fullscreenType: number;
    overlay: boolean;
    sandboxed: boolean;
    hidden: boolean;
    isLauncher: boolean;
}

export interface OrionRuntime {
    running: boolean;
    cleanups: Set<() => void>;
    skipped: Set<string>;
}
