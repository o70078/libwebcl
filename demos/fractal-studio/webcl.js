  /**
   * OpenCL: WebCL interface object
   * manage WebCL context, building OpenCL kernels and rendering fractals
   * (c) Owen Kaluza 2012
   */

  /**
   * @constructor
   */
  function OpenCL(pid, devid) {
    if (devid == undefined) devid = 0;
    this.pid = pid;
    this.devid = devid;
    this.fp64 = false;
    this.timer = null;
    this.resetInput();

    var cl = window.WebCL;
    if (!cl) throw "No WebCL interface";
    if (!cl.getPlatforms) throw "Unknown WebCL interface";
    try {
      //cl.getPlatforms();
      //Get & select platforms, devices
      this.platforms = WebCL.getPlatformIDs();
      if (this.pid == undefined || this.pid >= this.platforms.length)
        this.pid = 0;
    } catch (e) {
      print("detectCL exception: " + e);
      throw "No OpenCL drivers available"
    }

    if(this.platforms.length<1) throw "No OpenCL platforms found!";

    //Create the context
    this.ctx = WebCL.createContextFromType ([WebCL.CL_CONTEXT_PLATFORM, 
                                            this.platforms[this.pid]],
                                            WebCL.CL_DEVICE_TYPE_DEFAULT);
    this.devices = this.ctx.getContextInfo(WebCL.CL_CONTEXT_DEVICES);
    if (this.devid >= this.devices.length) this.devid = this.devices.length-1;

    debug("Using: " + this.platforms[this.pid].getPlatformInfo(WebCL.CL_PLATFORM_NAME) + " (" + this.pid + ")" +  
                " - " + this.devices[this.devid].getDeviceInfo(WebCL.CL_DEVICE_NAME) + " (" + this.devid + ")");

    //Check for double precision support
    var extensions = this.platforms[this.pid].getPlatformInfo(WebCL.CL_PLATFORM_EXTENSIONS);
    extensions += " " + this.devices[this.devid].getDeviceInfo(cl.CL_DEVICE_EXTENSIONS);
    if (/cl_khr_fp64|cl_amd_fp64/i.test(extensions))
      this.fp64 = true; //Initial state of flag shows availability of fp64 support
    debug("WebCL ready, extensions: " + extensions);
  }

  OpenCL.prototype.populateDevices = function(select) {
    //Clear & repopulate platforms+devices select list
    if (!select || !select.options) return;
    this.pfstrings = "";  //Info about available devices for debugging
    select.options.length = 0;
    for (var p=0; p<this.platforms.length; p++) {
      var plat = this.platforms[p];
      var pfname = plat.getPlatformInfo(WebCL.CL_PLATFORM_NAME);
      //Store debugging info about platforms found
      this.pfstrings += "+" + /^[^\s]*/.exec(pfname)[0];
      var devices = plat.getDevices(WebCL.CL_DEVICE_TYPE_ALL);
      for (var d=0; d < devices.length; d++) {
        var name = devices[d].getDeviceInfo(WebCL.CL_DEVICE_NAME) + ' (' + pfname + ')';
        select.options[select.length] = new Option(name, JSON.stringify({"pfid" : p, "devid" : d}));
        if (p == this.pfid && d == this.devid) select.selectedIndex = select.length-1;
        //Store debugging info about devices found
        var dtype = devices[d].getDeviceInfo(WebCL.CL_DEVICE_TYPE);
        if (dtype == WebCL.CL_DEVICE_TYPE_CPU)
          this.pfstrings += "-C"; 
        else if (dtype == WebCL.CL_DEVICE_TYPE_GPU)
          this.pfstrings += "-G";
        else
          this.pfstrings += "-O";
      }
    }
    if (select.selectedIndex < 0) select.selectedIndex = 0;
  }

  OpenCL.prototype.init = function(canvas, fp64, threads) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext("2d");
    this.gradientcanvas = document.getElementById('gradient');
    this.threads = threads;
    this.setPrecision(fp64);
    this.format = {channelOrder:WebCL.CL_RGBA, channelDataType:WebCL.CL_UNSIGNED_INT8};
    this.palette = this.ctx.createImage2D(WebCL.CL_MEM_READ_ONLY, this.format, this.gradientcanvas.width, 1, 0);
    this.queue = this.ctx.createCommandQueue(this.devices[this.devid], 0);
    this.setViewport(0, 0, canvas.width, canvas.height);
  }

  OpenCL.prototype.setPrecision = function(fp64) {
    this.fp64 = (fp64 == true && this.fp64);
    this.inBuffer = this.fp64 ? new Float64Array(256) : new Float32Array(256);
    this.input = this.ctx.createBuffer(WebCL.CL_MEM_READ_ONLY, this.inBuffer.byteLength);
  }

  OpenCL.prototype.buildProgram = function(kernelSrc) {
    if (this.timer) {clearTimeout(this.timer); this.timer = null;}
    if (!this.ctx) return;
    if (this.fp64) kernelSrc = "#define FP64\n" + kernelSrc;

    this.program = this.ctx.createProgramWithSource(kernelSrc);
    try {
      var options = "-cl-no-signed-zeros -cl-mad-enable -cl-fast-relaxed-math"
      this.program.buildProgram([this.devices[this.devid]], options);
      //debug("<hr>" + this.program.getProgramBuildInfo(this.devices[this.devid], WebCL.CL_PROGRAM_BUILD_LOG) + "<hr>");
    } catch(e) {
      throw "Failed to build WebCL program. Error "
            + this.program.getProgramBuildInfo(this.devices[this.devid], WebCL.CL_PROGRAM_BUILD_STATUS)
            + ":  " 
            + this.program.getProgramBuildInfo(this.devices[this.devid], WebCL.CL_PROGRAM_BUILD_LOG);
    }
    this.k_sample = this.program.createKernel("sample");
    this.k_sample.setKernelArg(0, this.palette);
    this.k_sample.setKernelArg(2, this.input);
    if (this.temp) this.k_sample.setKernelArg(1, this.temp);
    this.k_average = this.program.createKernel("average");
    if (this.output) this.k_average.setKernelArg(0, this.output);
    if (this.temp) this.k_average.setKernelArg(1, this.temp);
  }

  //Calculates global work size given problem size and thread count
  OpenCL.prototype.getGlobalSize = function(n, threads) {
    return threads * Math.ceil(n/threads);
  }

  //OpenCL.prototype.sizeChanged = function(width, height) {
  OpenCL.prototype.setViewport = function(x, y, width, height) {
    //Clear canvas first
    if (!this.ctx2d) {debug("SetViewport: No 2d context!"); return;}
    this.ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);

    //Adjust global size to at least [width][height], ensuring is a multiple of work-group size
    this.local = [this.threads, this.threads];
    this.global = [this.getGlobalSize(width, this.threads), this.getGlobalSize(height, this.threads)];
    if (this.global[0] <= 0 || this.global[1] <- 0) return;

    //If width and height changed, recreate output buffer
    if (!this.viewport || this.viewport.width != width || this.viewport.height != height) {
      this.viewport = new Viewport(x, y, width, height);
      this.output = this.ctx.createImage2D(WebCL.CL_MEM_WRITE_ONLY, this.format, this.global[0], this.global[1], 0);
      this.temp = this.ctx.createBuffer(WebCL.CL_MEM_READ_WRITE, this.global[0]*this.global[1]*4*4);
      if (this.k_sample) this.k_sample.setKernelArg (1, this.temp);
      if (this.k_average) this.k_average.setKernelArg(0, this.output);
      if (this.k_average) this.k_average.setKernelArg(1, this.temp);
    } else {
      this.viewport.x = x;
      this.viewport.y = y;
    }
  }

  OpenCL.prototype.resetInput = function() {
    //End index of built-in inputs
    this.incount = 11;
  }

  OpenCL.prototype.setInput = function(param, type, name) {
    //Set input values and return a declaration/initialisation for the kernel
    var declare = type + " " + name;

    if (param.typeid == 2) {
      this.inBuffer[this.incount] = param.value.re;
      declare += " = complex(input[" + (this.incount++);
      this.inBuffer[this.incount] = param.value.im;
      declare += "],input[" + (this.incount++) + "]);\n";
    } else {
      this.inBuffer[this.incount] = param.value;
      declare += " = (" + type + ")input[" + (this.incount++) + "];\n";
    }

    return declare;
  }

  OpenCL.prototype.draw = function(fractal, antialias, background) {
    if (!this.k_sample) return; //Sanity checks
    if (this.global[0] <= 0 || this.global[1] <= 0) return;
    if (this.timer) {clearTimeout(this.timer); this.timer = null;}
    if (antialias == undefined) antialias = 1;
    this.antialias = antialias;
    if (!this.queue) return;
    try {
      ctx_g = this.gradientcanvas.getContext("2d");
      this.outImage = this.ctx2d.createImageData(this.global[0], this.global[1]);
      var gradient = ctx_g.getImageData(0, 0, this.gradientcanvas.width, 1);

      //Pass additional args
      this.inBuffer[0] = fractal.position.zoom;
      this.inBuffer[1] = fractal.position.rotate;
      this.inBuffer[2] = fractal.position.pixelSize(this.canvas);
      this.inBuffer[3] = fractal.position.re;
      this.inBuffer[4] = fractal.position.im;
      this.inBuffer[5] = fractal.selected.re;
      this.inBuffer[6] = fractal.selected.im;
      //Background
      this.inBuffer[7] = background.red/255.0;
      this.inBuffer[8] = background.green/255.0;
      this.inBuffer[9] = background.blue/255.0;
      this.inBuffer[10] = background.alpha;

      this.k_sample.setKernelArg(3, antialias, WebCL.types.INT);
      this.k_sample.setKernelArg(4, (fractal.julia) ? 1 : 0, WebCL.types.INT);
      this.k_sample.setKernelArg(5, fractal.iterations, WebCL.types.INT);
      this.k_sample.setKernelArg(6, this.viewport.width, WebCL.types.INT);
      this.k_sample.setKernelArg(7, this.viewport.height, WebCL.types.INT);

      this.queue.enqueueWriteBuffer(this.input, false, 0, this.inBuffer.byteLength, this.inBuffer, []);

      this.queue.enqueueWriteImage(this.palette, false, [0,0,0], [gradient.width,1,1], gradient.width*4, 0, gradient.data, []);

      // Init ND-range
      debug("WebCL: Global (" + this.global[0] + "x" + this.global[1] + 
                   ") Local (" + this.local[0] + "x" + this.local[1] + ")");

      this.j = 0;
      this.k = 0;
      this.pass();

    } catch(e) {
      alert(e.message);
      throw e;
    }
  }

  OpenCL.prototype.pass = function() {
    //debug("Antialias pass ... " + this.j + " - " + this.k);
    this.k_sample.setKernelArg(8, this.j, WebCL.types.INT);
    this.k_sample.setKernelArg(9, this.k, WebCL.types.INT);
    //debug("Dims: " + this.global.length + " Global: " + JSON.stringify(this.global) + " Local: " + JSON.stringify(this.local));
    this.queue.enqueueNDRangeKernel(this.k_sample, this.global.length, [], this.global, this.local, []);
    //this.queue.enqueueNDRangeKernel(this.k_sample, this.global.length, [], this.global, [], []);

    //Combine
    this.k_average.setKernelArg(2, this.j*this.antialias+this.k+1, WebCL.types.INT);
    this.queue.enqueueNDRangeKernel(this.k_average, this.global.length, [], this.global, this.local, []);
    //this.queue.enqueueNDRangeKernel(this.k_average, this.global.length, [], this.global, [], []);

    this.queue.enqueueReadImage(this.output, false, [0,0,0], 
         [this.global[0],this.global[1],1], 0, 0, this.outImage.data, []);
    this.queue.finish();

    this.ctx2d.putImageData(this.outImage, this.viewport.x, this.viewport.y);

    //Next...
    this.k++;
    if (this.k >= this.antialias) {
      this.k = 0;
      this.j++;
    }

    if (this.j < this.antialias) {
      if (!this.time)
        this.pass();  //Don't draw incrementally when timers disabled
      else {
        var that = this;
        this.timer = setTimeout(function () {that.pass();}, 10);
      }
    } else {
      this.timer = null;
      if (this.time) this.time.print("Draw");
    }
  }


