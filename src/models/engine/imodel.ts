/** 
 * (C) Josh Netterfield <joshua@nettek.ca> 2015.
 * Part of the Satie music engraver <https://github.com/ripieno/satie>.
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * @file engine/imodel.ts Interface of and tools for models.
 */

"use strict";

import invariant        = require("react/lib/invariant");

import ICursor          = require("./icursor"); // @circular
import Measure          = require("./measure"); // @circular

/** 
 * Interface for models that implement objects that have a width, can be painted, take up time (divisions),
 * and/or change state. Examples include clefs, bars and notes.
 */
interface IModel {
    divCount?:       number;
    staffIdx:        number;
    frozenness:      IModel.FrozenLevel;

    /** 
     * Fields to serialize and de-serialize.
     */
    fields:          string[];

    /** 
     * Life-cycle method. Called when the model is created from MusicXML.
     * Prototype chains should be added to unfrozen properties.
     */
    modelDidLoad$(segment$: Measure.ISegmentRef): void;

    /** 
     * Life-cycle method. Called before an attempt is made to layout the models.
     * Any changes to the current segment should be done here. For example, notation
     * checking is done here.
     */
    validate$(cursor$: ICursor): void;

    /** 
     * Life-cycle method. Called to layout the models.
     * At this point, all segments are frozen and must not be changed.
     */
    layout(cursor$: ICursor): IModel.ILayout;
};

module IModel {
    export interface IFactory {
        create: (modelType: IModel.Type, options?: any) => IModel;
        fromSpec: (spec: any) => IModel;
        modelHasType: (model: IModel, ...modelTypes: IModel.Type[]) => boolean;
    }

    export enum FrozenLevel {
        /** For rests at the end of a bar only. The model is unfrozen and can be shortened as needed. */
        WarmPushable,

        /** The model can be modified to apply best practices. */
        Warm,

        /** The model can be modified to apply best practices in this frame, but will be frozen to additional changes. */
        Freezing,

        /** Only downright errors can be fixed. */
        Frozen,

        /** Like frozen, but position is also fixed. */
        FrozenEngraved
    }

    export enum HMergePolicy {
        Invalid                 = 0,
        Max                     = 1,
        Min                     = 2
    }

    export enum Type {
        START_OF_LAYOUT_ELEMENTS    = 0,
        Print                       = 10,           // Implements MusicXML.Print
        Barline                     = 20,           // Implements MusicXML.Barline
        Grouping                    = 30,           // Implements MusicXML.Grouping
        FiguredBass                 = 40,
        END_OF_LAYOUT_ELEMENTS      = 99,

        START_OF_STAFF_ELEMENTS     = 100,
        Attributes                  = 110,          // Implements MusicXML.Attributes
        Sound                       = 120,          // Implements MusicXML.Sound
        Direction                   = 130,          // Implements MusicXML.Direction
        Harmony                     = 140,          // Implements MusicXML.Harmony
        Proxy                       = 150,          // Does not implement a MusicXML API
        END_OF_STAFF_ELEMENTS       = 199,

        START_OF_VOICE_ELEMENTS     = 200,
        BeamGroup                   = 210,          // Does not implement a MusicXML API
        Chord                       = 220,          // Like MusicXML.Note[]
        END_OF_VOICE_ELEMENTS       = 299,

        Unknown                     = 1000
    };

    export interface ILayout {
        model: IModel;

        x$: number;
        division: number;
        mergePolicy: HMergePolicy;

        /** 
         * References to bounding rectangles for annotations such as dots, words,
         * and slurs. The layout engine may modify these bounding rects to avoid
         * collisions and improve the look.
         * 
         * Lengths are in MusicXML tenths relative to (this.x, center line of staff),
         */
        boundingBoxes$?: IBoundingRect[];
        priority: Type;

        expandable?: boolean;
    }
    export module ILayout {
        function replacer(key: string, value: any) {
            return key === "model" ? undefined : value;
        }
        export function detach(layout: ILayout) {
            var clone: ILayout = JSON.parse(JSON.stringify(layout, replacer));
            clone.model = layout.model;
            return clone;
        }
    }

    export interface IBoundingRect {
        frozenness:     IModel.FrozenLevel;
        x:              number;
        y:              number;
        w:              number;
        h:              number;
    }

    export interface ICombinedLayout {
        x: number;
        mergePolicy: HMergePolicy;
        division: number;
        priority: Type;
        expandable?: boolean;
    }

    export function detachLayout(layout: IModel.ILayout): ICombinedLayout {
        var detached: ICombinedLayout = {
            x:              layout.x$,
            division:       layout.division,
            mergePolicy:    layout.mergePolicy,
            priority:       layout.priority
        };
        if (layout.expandable) {
            detached.expandable = true;
        }
        return detached;
    }

    export function reattachLayout(layout: IModel.ICombinedLayout): ILayout {
        var attached: ILayout = {
            model:          null,
            x$:             layout.x,
            division:       layout.division,
            mergePolicy:    layout.mergePolicy,
            priority:       layout.priority
        };
        if (layout.expandable) {
            attached.expandable = true;
        }

        return attached;
    }

    /** 
     * Helper to line up two streams that have some overlap.
     * Divisions in each segment must be the same.
     * 
     * @code
     * var memo =_.reduce(segments, IModelLayout.merge$, []);
     * _.reduce(segments, IModelLayout.merge$, memo);
     */
    export function merge$(segment1$: ICombinedLayout[], segment2$: ILayout[]): ICombinedLayout[] {
        var s1_idx = 0;
        var s2_idx = 0;
        var division: number;
        var x: number;

        while (s1_idx < segment1$.length || s2_idx < segment2$.length) {
            var item1 = segment1$[s1_idx];
            var item2 = segment2$[s2_idx];

            var div1 = !!item1 ? item1.division : Number.MAX_VALUE;
            var pri1 = !!item1 ? item1.priority : Number.MAX_VALUE;
            var div2 = !!item2 ? item2.division : Number.MAX_VALUE;
            var pri2 = !!item2 ? item2.priority : Number.MAX_VALUE;

            division = Math.min(div1, div2);
            if (div1 < div2 || div1 === div2 && pri1 < pri2) {
                x = item1.x;
                invariant(!!segment2$, "Segment2 must be defined");
                segment2$.splice(s2_idx, 0, reattachLayout(item1));
            } else if (div2 < div1 || div2 === div1 && pri2 < pri1) {
                x = item2.x$;
                segment1$.splice(s1_idx, 0, detachLayout(item2));
            } else {
                invariant(!!item1, "div2 must be defined and have a valid division (is %s) & priority (is %s)",
                    div2, pri2);
                invariant(!!item2, "div1 must be defined and have a valid division (is %s) & priority (is %s)",
                    div1, pri1);
                switch(segment2$[s2_idx].mergePolicy) {
                    case HMergePolicy.Max:
                        x = Math.max(item1.x, item2.x$);
                        break;
                    case HMergePolicy.Min:
                        x = Math.min(item1.x, item2.x$);
                        break;
                    default:
                        invariant(false, "Invalid merge policy %s", segment2$[s2_idx].mergePolicy);
                        break;
                }
                item1.x = item2.x$ = x;
            }
            ++s1_idx;
            ++s2_idx;
        };
        return segment1$;
    }
}

// Register Note as Chord.
(<any>IModel.Type)["Note"] = IModel.Type.Chord;

export = IModel;
