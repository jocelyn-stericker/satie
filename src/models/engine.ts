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
 * @file Tools for creating, validating, and laying out models.
 * 
 * 1. Render Flow
 * ==============
 * 
 * De-serialization (JSON -> "UNVALIDATED")
 * ----------------------------------------
 *   0. MusicXML is translated into MXMLJSON                      (MusicXML.parse)
 *   1. MXMLJSON is converted to Satie Models                (MXML.Import.toScore)
 *   2. Model does initial housework                        (IModel.modelDidLoad$)
 * 
 * Validation ("UNVALIDATED" -> "VALIDATED")
 * -----------------------------------------
 *   3. A model reads the context given to it by models before it
 *      in a bar and can modify context the for future models.  (IModel.validate$)
 *   4. Layout is guessed within a bar, voice, and staff           (IModel.layout)
 * 
 *      Models can pretend there is only one voice and one
 *      staff. The engine itself handles merging voices and staffs,
 *      as well as complex notation involving one voice across
 *      multiple staves.
 * 
 *      Layouts for VALIDATED and RENDERED models are memoized,
 *      so that neither validate$ layout need to be called on
 *      Models when a change happens that does not affect it.
 * 
 * Lay-out ("VALIDATED" -> "RENDERED")
 * -----------------------------------
 *   5. Context gets assigned a page and line based on guess      (Engine.layout$)
 *   6. Actual layout created                                      (IModel.layout)
 *   7. Layout is justified or semi-justified, and assigned a
 *      vertical position
 *   8. Elements outside of staff (lyrics, notations, ...) are
 *      positioned
 * 
 * 2. Box Model
 * ============
 * 
 * Satie's layout model is based on MusicXML's default and relative positioning.
 * See MusicXML.Position. Contrary to SVG where the origin is the top left corner,
 * the origin in MusicXML and Satie is the bottom left corner.
 * 
 * The position of an object, in SVG coordinates scaled to equal tenths, is calculated as:
 *  x = context.originX + layout.model.defaultX + model.relativeX
 *  y = context.originY - layout.model.defaultY - model.defaultY
 * 
 * relativeX and relativeY
 * -----------------------
 * Manual or special-case changes to the default position calculated in validate$ or fit$.
 * 
 * defaultX and defaultY
 * ---------------------
 * These values are generally calculated in the layout layer of the engraving process, but
 * can be set manually. Layouts extend the model they hold via prototypical inheritance
 * to set defaultX and defaultY if it was not already set in the manual.
 * 
 * originX and originY
 * -------------------
 * Different objects have different positions in MusicXML. For example, credits are relative
 * to (0, height), so originX = 0 and originY = height. Notes are relative to the top (!!) left
 * of a measure. See MusicXML documentation for each component. originX and originY are set
 * by React context.
 * 
 * React provides three ways of storing information. State is useful for storing data used by
 * the same component that sets it. Props is useful for passing date from one component
 * to its direct children. Context is like props, but can be passed to non-direct children. It
 * is currently undocumented. See MeasureView and Attributes for an example of context is used.
 * 
 * 3. Editing Flow
 * ===============
 * 
 * Editing ("RENDERED" -> "UNVALIDATED")
 * -------------------------------------
 *   When any element in a measure is added, removed, or modified, all items in that
 *   measure go from the RENDERED state to the UNVALIDATED state.
 * 
 *   Note: some changes are done without changing the context model or layout
 *   model state. These changes are made with {dangerous: true}, and are used
 *   to provide constant time previews in Ripieno.
 * 
 * Line switches ("RENDERED" -> "VALIDATED")
 * -----------------------------------------
 *   When a measure is moved from one line to another, all models in the two lines
 *   that are RENDERED become VALIDATED. This implies that models must remain CLEAN
 *   when switching lines, and CLEAN Models must not mutate based on what else is on
 *   the same line, but not the same measure, as it. Instead, this information must
 *   be kept in IModel.layout. This constraint ensures linear time updates on the
 *   number of models on lines modified and promotes robustness.
 * 
 *   Keep in mind:
 *     - Every measure must have a valid Attributes which can be unhidden
 *       (via its ILayout!) if it becomes the first in a line.
 *     - Every measure must also have a valid warning Clef at the end which can be
 *       unhidden via ILayout.
 *     - Concerns related to accidentals and the vertical position of notes in a
 *       staff must be done in layout without changes to the Model.
 */

"use strict";

import MusicXML                 = require("musicxml-interfaces");
import _                        = require("lodash");
import invariant                = require("react/lib/invariant");

export import IBeam             = require("./engine/ibeam");
export import IChord            = require("./engine/ichord");
export import ICursor           = require("./engine/icursor");
export import IModel            = require("./engine/imodel");
export import IPrint            = require("./engine/iprint");
export import Measure           = require("./engine/measure");
export import Options           = require("./engine/options");
export import RenderUtil        = require("./engine/renderUtil");
export import ScoreHeader       = require("./engine/scoreHeader");

import IAttributes              = require("./engine/iattributes");
import Ctx                      = require("./engine/ctx");
import LineProcessor            = require("./engine/lineProcessor");
import MeasureProcessor         = require("./engine/measureProcessor");

if (!(<any>process).browser) {
    /* tslint:disable */
    require("source-map-support").install();
    /* tslint:enable */
}

/*---- Engine -----------------------------------------------------------------------------------*/

export function validate$(options$: Options.ILayoutOptions, memo$: Options.ILinesLayoutState): void {
    options$.measures = _.reduce(options$.preProcessors, (measures, processor) => processor(measures), options$.measures);

    let shouldTryAgain: boolean;
    do {
        shouldTryAgain = false;
        try {
            tryValidate$(options$, memo$);
        } catch(err) {
            if (err instanceof MeasureProcessor.DivisionOverflowException) {
                (<MeasureProcessor.DivisionOverflowException>err).resolve$(options$.measures);
                shouldTryAgain = true;
            } else {
                throw err;
            }
        }
    } while(shouldTryAgain);
}

function tryValidate$(options$: Options.ILayoutOptions, memo$: Options.ILinesLayoutState): void {
    let factory         = options$.modelFactory;
    let search          = factory.search.bind(factory);

    EscapeHatch.__currentMeasureList__ = options$.measures;

    let lastAttribs: {[part: string]: MusicXML.Attributes} = {};

    function withPart(segments: Measure.ISegment[], partID: string): Measure.ISegment[] {
        _.forEach(segments, segment => {
            if (segment) {
                segment.part = partID;
            }
        });
        return segments;
    }

    // Normalize divisions on a line:
    let allSegments: Measure.ISegment[] = [];
    _.forEach(options$.measures, function validateMeasure(measure) {
        let voiceSegments$ = <Measure.ISegment[]>
            _.flatten(_.map(_.pairs(measure.parts),
                        partx => withPart(partx[1].voices, partx[0])));

        let staffSegments$ = <Measure.ISegment[]>
            _.flatten(_.map(_.pairs(measure.parts),
                        partx => withPart(partx[1].staves, partx[0])));

        allSegments = allSegments.concat(_.filter(voiceSegments$.concat(staffSegments$), s => !!s));
    });
    Measure.normalizeDivisons$(allSegments, 0);
    // TODO: check if a measure hence becomes dirty?

    _.forEach(options$.measures, function validateMeasure(measure) {
        if (!(measure.uuid in memo$.clean$)) {
            let voiceSegments$ = <Measure.ISegment[]>
                _.flatten(_.map(_.pairs(measure.parts),
                            partx => withPart(partx[1].voices, partx[0])));

            let staffSegments$ = <Measure.ISegment[]>
                _.flatten(_.map(_.pairs(measure.parts),
                            partx => withPart(partx[1].staves, partx[0])));

            let measureCtx = Ctx.IMeasure.detach(measure, 0);
            let segments = _.filter(voiceSegments$.concat(staffSegments$), s => !!s);

            _.forEach(staffSegments$, function(segment, idx) {
                if (!segment) {
                    return;
                }
                function ensureHeader(type: IModel.Type) {
                    if (!search(segment, 0, type).length) {
                        if (idx === 1) {
                            segment.splice(0, 0, factory.create(type));
                        } else {
                            let proxy = factory.create(IModel.Type.Proxy);
                            let target = search(staffSegments$[1], 0, type)[0];
                            (<any>proxy).target = target;
                            (<any>proxy).staffIdx = idx;
                            let tidx = -1;
                            for (var i = 0; i < staffSegments$[1].length; ++i) {
                                if (staffSegments$[1][i] === target) {
                                    tidx = i;
                                    break;
                                }
                            }
                            invariant(tidx !== -1, "Could not find required model.");
                            segment.splice(tidx, 0, proxy);
                        }
                    }
                }
                ensureHeader(IModel.Type.Print);
                ensureHeader(IModel.Type.Attributes);
                if (!search(segment, segment.length - 1, IModel.Type.Barline).length) {
                    // Make sure the barline ends up at the end.
                    const divs = _.reduce(segment, (divs, model) => divs + model.divCount, 1);
                    if (divs !== 0) {
                        const spacer = factory.create(IModel.Type.Spacer);
                        spacer.divCount = divs;
                        segment.splice(segment.length, 0, spacer);
                    }
                    segment.splice(segment.length, 0, factory.create(IModel.Type.Barline));
                }
            });

            let outcome = MeasureProcessor.reduce({
                attributes:     lastAttribs,
                header:         options$.header,
                line:           null,
                measure:        measureCtx,
                prevByStaff:    null,
                padEnd:         false,
                segments:       segments,
                _approximate:   true,
                _detached:      true,
                _noAlign:       true,
                _validateOnly:  true, // Just validate, don't make a layout
                factory:        factory
            });
            lastAttribs = outcome.attributes;
        }
    });

    EscapeHatch.__currentMeasureList__ = null;
}

export function layout$(options: Options.ILayoutOptions,
        memo$: Options.ILinesLayoutState): Options.ILineLayoutResult[] {
    EscapeHatch.__currentMeasureList__ = options.measures;

    // We lay out measures in two passes.
    // First, we calculate the approximate width of measures and assign them to lines.
    // Then, we lay them out properly with a valid line context.

    let measures = options.measures;
    let width$ = memo$.width$;
    let multipleRests$ = memo$.multipleRests$;

    invariant(!!options.print$, "Print not defined");
    let boundsGuess = Options.ILineBounds.calculate(options.print$, options.page$);
    let multipleRest: number = undefined;

    let approximateWidths = _.map(measures, function layoutMeasure(measure, idx) {
        // Create an array of the IMeasureParts of the previous, current, and next measures
        let neighbourMeasures: Measure.IMeasurePart[] = <any> _.flatten([
            !!measures[idx - 1] ? _.values(measures[idx - 1].parts) : <Measure.IMeasurePart> {
                voices: [],
                staves: []
            },
            _.values(measure.parts),
            !!measures[idx + 1] ? _.values(measures[idx + 1].parts) : <Measure.IMeasurePart> {
                voices: [],
                staves: []
            }
        ]);
        // Join all of the above models
        let neighbourModels = <Measure.ISegment[]> _.flatten(
            _.map(neighbourMeasures, m => m.voices.concat(m.staves))
        );
        if (!(measure.uuid in width$)) {
            let specifiedWidth = measure.width; // TODO: Use EngravedStatus
            if (!isNaN(measure.width) && measure.width !== null && (measure.width <= 0 || !isFinite(measure.width))) {
                console.warn("Bad measure width %s. Ignoring", measure.width);
                specifiedWidth = undefined;
            }

            let approximateLayout = MeasureProcessor.approximateLayout({
                attributes:     options.attributes,
                factory:        options.modelFactory,
                header:         options.header,
                line:           Ctx.ILine.create(neighbourModels, measures.length, 0, 1),
                measure:        measure,
                prevByStaff:    [], // FIXME:
                staves:         _.map(_.values(measure.parts), p => p.staves),
                voices:         _.map(_.values(measure.parts), p => p.voices),
                x:              0
            });
            let firstPart = options.header.partList.scoreParts[0].id;
            // TODO: Only skip render multiple rests if __all__ visible parts have rests
            if (approximateLayout.attributes &&
                    approximateLayout.attributes[firstPart] &&
                    approximateLayout.attributes[firstPart].measureStyle &&
                    approximateLayout.attributes[firstPart].measureStyle.multipleRest) {
                multipleRest = multipleRests$[measure.uuid] = approximateLayout.attributes[firstPart].measureStyle.multipleRest.count - 1;
            } else if (!isNaN(multipleRest)) {
                multipleRests$[measure.uuid] = multipleRest;
                approximateLayout.width = 0;
            } else {
                delete multipleRests$[measure.uuid];
            }
            width$[measure.uuid] = {
                width: specifiedWidth || approximateLayout.width,
                attributesWidthStart: IAttributes.approximateWidth(approximateLayout.attributes),
                attributesWidthEnd: IAttributes.approximateWidth(approximateLayout.attributes, IAttributes.AtEnd.Yes)
            };
        }
        multipleRest = multipleRest ? multipleRest - 1 : undefined;
        return width$[measure.uuid];
    });

    let thisPrint: MusicXML.Print = options.print$;
    function updatePrint(measure: Measure.IMutableMeasure) {
        let partWithPrint = _.find(measure.parts, part => !!part.staves[1] &&
                options.modelFactory.search(part.staves[1], 0, IModel.Type.Print).length);
        if (partWithPrint) {
            let print = <any> options.modelFactory.search(partWithPrint.staves[1], 0,
                    IModel.Type.Print)[0];
            thisPrint = print;
        }
    }
    function newLayoutWithoutMeasures(): Options.ILayoutOptions {
        return {
            attributes:     null,
            measures:       [],
            header:         options.header,
            print$:         thisPrint,
            finalLine:      false,
            page$:          options.page$,
            modelFactory:   options.modelFactory,
            preProcessors:  options.preProcessors,
            postProcessors: options.postProcessors
        };
    }

    // Here we assign the lines.
    // It's currently very naive, and could use some work.

    let startingWidth = boundsGuess.right - boundsGuess.left;
    let lineOpts$ = _.reduce(approximateWidths, function(memo, width, idx) {
        updatePrint(measures[idx]);
        memo.opts[memo.opts.length - 1].print$ = thisPrint;
        invariant(!!thisPrint, "No print found");
        if (width.attributesWidthStart > memo.widthAllocatedForStart) {
            memo.remainingWidth -= width.attributesWidthStart - memo.widthAllocatedForStart;
            memo.widthAllocatedForStart = width.attributesWidthStart;
        }
        if (width.attributesWidthEnd > memo.widthAllocatedForEnd) {
            memo.remainingWidth -= width.attributesWidthEnd - memo.widthAllocatedForEnd;
            memo.widthAllocatedForEnd = width.attributesWidthEnd;
        }
        if (memo.remainingWidth > width.width) {
            memo.remainingWidth -= width.width;
        } else {
            memo.opts.push(newLayoutWithoutMeasures());
            memo.remainingWidth = startingWidth - width.width - width.attributesWidthStart - width.attributesWidthEnd;
            memo.widthAllocatedForStart = width.attributesWidthStart;
            memo.widthAllocatedForEnd = width.attributesWidthEnd;
        }
        memo.opts[memo.opts.length - 1].measures.push(measures[idx]);
        memo.opts[memo.opts.length - 1].line = memo.opts.length - 1;
        return memo;
    }, {
        opts: <Options.ILayoutOptions[]>[newLayoutWithoutMeasures()],
        remainingWidth: startingWidth,
        widthAllocatedForStart: 0,
        widthAllocatedForEnd: 0
    }).opts;

    // layoutLine$ handles the second pass.
    let layout = _.map(lineOpts$, function secondPass(lineOpt$) {
        lineOpt$.lines = lineOpts$.length;
        return LineProcessor.layoutLine$(lineOpt$, Options.ILineBounds.calculate(lineOpt$.print$,
                options.page$), memo$);
    });

    EscapeHatch.__currentMeasureList__ = null;
    return layout;
}

export function mutate$(options: Options.ILayoutOptions,
        memo$: Options.ILinesLayoutState, measureUUID: number,
        mutator: (measure$: Measure.IMutableMeasure) => void) {
    delete memo$.clean$[measureUUID];
    delete memo$.width$[measureUUID];
    mutator(_.find(options.measures, {"uuid": measureUUID}));
    // XXX: Call layout
    throw "Not implemented";
}

/**
 * Contains data that a ScoreStore can consume.
 */
export interface IDocument {
    error?:     any;
    factory?:   IModel.IFactory;
    header?:    ScoreHeader;
    measures?:  Measure.IMutableMeasure[];
    parts?:     string[];
}

export enum RenderTarget {
    SvgWeb = 0,
    SvgExport = 1
}

export const key$ = MeasureProcessor.key$;
export const MAX_SAFE_INTEGER = MeasureProcessor.MAX_SAFE_INTEGER;

export module EscapeHatch {
    export let __currentMeasureList__: Measure.IMutableMeasure[];
}

