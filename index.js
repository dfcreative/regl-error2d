'use strict'

const createRegl = require('regl')
const getBounds = require('array-bounds')
const rgba = require('color-rgba')
const updateDiff = require('update-diff')
const pick = require('pick-by-alias')
const extend = require('object-assign')
const flatten = require('flatten-vertex-data')

module.exports = Error2D

const WEIGHTS = [
	//direction, lineWidth shift, capSize shift

	// x-error bar
	[1, 0, 0, 1, 0, 0],
	[1, 0, 0, -1, 0, 0],
	[-1, 0, 0, -1, 0, 0],

	[-1, 0, 0, -1, 0, 0],
	[-1, 0, 0, 1, 0, 0],
	[1, 0, 0, 1, 0, 0],

	// x-error right cap
	[1, 0, -1, 0, 0, 1],
	[1, 0, -1, 0, 0, -1],
	[1, 0, 1, 0, 0, -1],

	[1, 0, 1, 0, 0, -1],
	[1, 0, 1, 0, 0, 1],
	[1, 0, -1, 0, 0, 1],

	// x-error left cap
	[-1, 0, -1, 0, 0, 1],
	[-1, 0, -1, 0, 0, -1],
	[-1, 0, 1, 0, 0, -1],

	[-1, 0, 1, 0, 0, -1],
	[-1, 0, 1, 0, 0, 1],
	[-1, 0, -1, 0, 0, 1],

	// y-error bar
	[0, 1, 1, 0, 0, 0],
	[0, 1, -1, 0, 0, 0],
	[0, -1, -1, 0, 0, 0],

	[0, -1, -1, 0, 0, 0],
	[0, 1, 1, 0, 0, 0],
	[0, -1, 1, 0, 0, 0],

	// y-error top cap
	[0, 1, 0, -1, 1, 0],
	[0, 1, 0, -1, -1, 0],
	[0, 1, 0, 1, -1, 0],

	[0, 1, 0, 1, 1, 0],
	[0, 1, 0, -1, 1, 0],
	[0, 1, 0, 1, -1, 0],

	// y-error bottom cap
	[0, -1, 0, -1, 1, 0],
	[0, -1, 0, -1, -1, 0],
	[0, -1, 0, 1, -1, 0],

	[0, -1, 0, 1, 1, 0],
	[0, -1, 0, -1, 1, 0],
	[0, -1, 0, 1, -1, 0]
]


function Error2D (options) {
	if (!options) options = {}
	else if (typeof options === 'function') options = {regl: options}
	else if (options.length) options = {positions: options}

	// persistent variables
	let regl, gl, drawErrors, positionBuffer, positionFractBuffer, colorBuffer, errorBuffer, meshBuffer,
			defaultOptions = {
				color: 'black',
				capSize: 5,
				lineWidth: 1,
				opacity: 1,
				viewport: null,
				range: null,
				offset: 0,
				count: 0,
				bounds: null,
				positions: [],
				errors: []
			}

	let groups = []


	// regl instance
	if (options.regl) regl = options.regl

	// container/gl/canvas case
	else {
		let opts

		if (options instanceof HTMLCanvasElement) opts = {canvas: options}
		else if (options instanceof HTMLElement) opts = {container: options}
		else if (options.drawingBufferWidth || options.drawingBufferHeight) opts = {gl: options}

		else {
			opts = pick(options, 'pixelRatio canvas container gl extensions')
		}

		if (!opts.extensions) opts.extensions = []

		opts.extensions.push('ANGLE_instanced_arrays')

		regl = createRegl(opts)
	}

	gl = regl._gl

	//color per-point
	colorBuffer = regl.buffer({
		usage: 'dynamic',
		type: 'uint8',
		data: null
	})
	//xy-position per-point
	positionBuffer = regl.buffer({
		usage: 'dynamic',
		type: 'float',
		data: null
	})
	//xy-position float32-fraction
	positionFractBuffer = regl.buffer({
		usage: 'dynamic',
		type: 'float',
		data: null
	})
	//4 errors per-point
	errorBuffer = regl.buffer({
		usage: 'dynamic',
		type: 'float',
		data: null
	})
	//error bar mesh
	meshBuffer = regl.buffer({
		usage: 'static',
		type: 'float',
		data: WEIGHTS
	})

	update(options)

	//drawing method
	drawErrors = regl({
		vert: `
		precision highp float;

		attribute vec2 position, positionFract;
		attribute vec4 error;
		attribute vec4 color;

		attribute vec2 direction, lineOffset, capOffset;

		uniform vec2 pixelScale;
		uniform float lineWidth, capSize;
		uniform vec2 scale, scaleFract, translate, translateFract;

		varying vec4 fragColor;

		void main() {
			fragColor = color;

			vec2 pixelOffset = lineWidth * lineOffset + (capSize + lineWidth) * capOffset;

			vec2 dxy = -step(.5, direction.xy) * error.xz + step(direction.xy, vec2(-.5)) * error.yw;

			vec2 position = position + dxy;

			vec2 pos = (position + translate) * scale
				+ (positionFract + translateFract) * scale
				+ (position + translate) * scaleFract
				+ (positionFract + translateFract) * scaleFract;

			pos += pixelScale * pixelOffset;

			gl_Position = vec4(pos * 2. - 1., 0, 1);
		}
		`,

		frag: `
		precision mediump float;

		varying vec4 fragColor;

		uniform float opacity;

		void main() {
			gl_FragColor = fragColor / 255.;
			gl_FragColor.a *= opacity;
		}
		`,

		uniforms: {
			range: regl.prop('range'),
			lineWidth: regl.prop('lineWidth'),
			capSize: regl.prop('capSize'),
			opacity: regl.prop('opacity'),
			scale: regl.prop('scale'),
			translate: regl.prop('translate'),
			scaleFract: regl.prop('scaleFract'),
			translateFract: regl.prop('translateFract'),
			pixelScale: ctx => [
				ctx.pixelRatio / ctx.viewportWidth,
				ctx.pixelRatio / ctx.viewportHeight
			]
		},

		attributes: {
			//dynamic attributes
			color: {
				buffer: colorBuffer,
				divisor: 1,
			},
			position: {
				buffer: positionBuffer,
				divisor: 1
			},
			positionFract: {
				buffer: positionFractBuffer,
				divisor: 1
			},
			error: {
				buffer: errorBuffer,
				divisor: 1
			},

			//static attributes
			direction: {
				buffer: meshBuffer,
				stride: 24,
				offset: 0
			},
			lineOffset: {
				buffer: meshBuffer,
				stride: 24,
				offset: 8
			},
			capOffset: {
				buffer: meshBuffer,
				stride: 24,
				offset: 16
			}
		},

		primitive: 'triangles',

		blend: {
			enable: true,
			color: [0,0,0,0],
			equation: {
				rgb: 'add',
				alpha: 'add'
			},
			func: {
				srcRGB: 'src alpha',
				dstRGB: 'one minus src alpha',
				srcAlpha: 'one minus dst alpha',
				dstAlpha: 'one'
			}
		},

		depth: {
			enable: false
		},

		scissor: {
			enable: true,
			box: regl.prop('viewport')
		},
		viewport: regl.prop('viewport'),
		stencil: false,

		instances: regl.prop('count'),
		count: WEIGHTS.length
	})

	//expose API
	extend(error2d, {
		update: update,
		draw: draw,
		destroy: destroy,
		regl: regl,
		gl: gl,
		canvas: gl.canvas,
		groups: groups
	})

	function error2d (opts) {
		//update
		if (opts) {
			update(opts)
		}

		//destroy
		else if (opts === null) {
			destroy()
		}

		draw(opts)
	}


	//main draw method
	function draw (options) {
		if (typeof options === 'number') return drawGroup(options)

		//make options a batch
		if (options && !Array.isArray(options)) options = [options]


		regl._refresh()

		//render multiple polylines via regl batch
		groups.filter(s => s && s.count && s.color && s.opacity && s.positions)
			.forEach((s, i) => {
			if (options) {
				if (!options[i]) s.draw = false
				else s.draw = true
			}

			//ignore draw flag for one pass
			if (!s.draw) {
				s.draw = true;
				return
			}

			drawGroup(i)
		})
	}

	//draw single error group by id
	function drawGroup (s) {
		if (typeof s === 'number') s = groups[s]

		if (!s) return

		s.scaleRatio = [
			s.scale[0] * s.viewport.width,
			s.scale[1] * s.viewport.height
		]

		drawErrors(s)

		if (s.after) s.after(s)
	}

	function update (options) {
		//direct points argument
		if (options.length != null) {
			if (typeof options[0] === 'number') options = {positions: options}
		}

		//make options a batch
		if (!Array.isArray(options)) options = [options]

		//global count of points
		let pointCount = 0, errorCount = 0

		groups = options.map((options, i) => {
			let group = groups[i]

			if (!options) options = {}
			else if (typeof options === 'function') options = {after: options}
			else if (typeof options[0] === 'number') options = {positions: options}

			//copy options to avoid mutation & handle aliases
			options = pick(options, {
				color: 'color colors fill',
				capSize: 'capSize cap capsize cap-size',
				lineWidth: 'lineWidth line-width width line',
				opacity: 'opacity alpha',
				range: 'range dataBox',
				viewport: 'viewport viewBox',
				errors: 'errors error',
				positions: 'positions position data points'
			})

			if (!group) {
				groups[i] = group = {
					id: i,
					scale: null,
					translate: null,
					scaleFract: null,
					translateFract: null,
					draw: true
				}
				options = extend({}, defaultOptions, options)
			}

			updateDiff(group, options, [{
				lineWidth: v => +v * .5,
				capSize: v => +v * .5,
				opacity: parseFloat,
				errors: errors => {
					errors = flatten(errors)

					errorCount += errors.length
					return errors
				},
				positions: (positions, state) => {
					positions = flatten(positions, 'float64')
					state.count = Math.floor(positions.length / 2)
					state.bounds = getBounds(positions, 2)
					state.offset = pointCount

					pointCount += state.count

					return positions
				}
			}, {
				color: (colors, state) => {
					let count = state.count

					if (!colors) colors = 'transparent'

					// 'black' or [0,0,0,0] case
					if (!Array.isArray(colors) || typeof colors[0] === 'number') {
						colors = Array(count).fill(colors)
					}

					if (colors.length < count) throw Error('Not enough colors')

					let colorData = new Uint8Array(count * 4)

					//convert colors to float arrays
					for (let i = 0; i < count; i++) {
						let c = colors[i]
						if (typeof c === 'string') {
							c = rgba(c, false)
						}
						colorData[i*4] = c[0]
						colorData[i*4 + 1] = c[1]
						colorData[i*4 + 2] = c[2]
						colorData[i*4 + 3] = c[3] * 255
					}

					return colorData
				},

				range: (range, state, options) => {
					let bounds = state.bounds
					if (!range) range = bounds

					state.scale = [1 / (range[2] - range[0]), 1 / (range[3] - range[1])]
					state.translate = [-range[0], -range[1]]

					state.scaleFract = fract32(state.scale)
					state.translateFract = fract32(state.translate)

					return range
				},

				viewport: vp => {
					let viewport

					if (Array.isArray(vp)) {
						viewport = {
							x: vp[0],
							y: vp[1],
							width: vp[2] - vp[0],
							height: vp[3] - vp[1]
						}
					}
					else if (vp) {
						viewport = {
							x: vp.x || vp.left || 0,
							y: vp.y || vp.top || 0
						}

						if (vp.right) viewport.width = vp.right - viewport.x
						else viewport.width = vp.w || vp.width || 0

						if (vp.bottom) viewport.height = vp.bottom - viewport.y
						else viewport.height = vp.h || vp.height || 0
					}
					else {
						viewport = {
							x: 0, y: 0,
							width: gl.drawingBufferWidth,
							height: gl.drawingBufferHeight
						}
					}

					return viewport
				}
			}])

			return group
		})

		if (pointCount || errorCount) {
			let len = groups.reduce((acc, group, i) => {
				return acc + group.count
			}, 0)

			let positionData = new Float64Array(len * 2)
			let colorData = new Uint8Array(len * 4)
			let errorData = new Float32Array(len * 4)

			groups.forEach((group, i) => {
				let {positions, count, offset, color, errors} = group
				if (!count) return

				colorData.set(color, offset * 4)
				errorData.set(errors, offset * 4)
				positionData.set(positions, offset * 2)
			})

			positionBuffer(float32(positionData))
			positionFractBuffer(fract32(positionData))
			colorBuffer(colorData)
			errorBuffer(errorData)
		}

	}

	function destroy () {
		positionBuffer.destroy()
		positionFractBuffer.destroy()
		colorBuffer.destroy()
		errorBuffer.destroy()
		meshBuffer.destroy()
		regl.destroy()
	}

	return error2d
}

//return fractional part of float32 array
function fract32 (arr) {
	let fract = new Float32Array(arr.length)
	fract.set(arr)
	for (let i = 0, l = fract.length; i < l; i++) {
		fract[i] = arr[i] - fract[i]
	}
	return fract
}
function float32 (arr) {
	if (arr instanceof Float32Array) return arr

	let float = new Float32Array(arr)
	float.set(arr)
	return float
}
